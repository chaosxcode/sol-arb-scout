import { Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CFG } from './config.js';
import { scanOnce, tierCounts, type Opportunity } from './scanner.js';
import { laneStats, quote, type Quote } from './jupiter.js';
import { SOL, TOKENS } from './tokens.js';
import { startWatcher, addToken, dropToken, watchSummary, books, localRoundTrip, type TokenBook, type SignalResult } from './watch.js';
import { screenTokens } from './discover.js';
import { swapOut, modelOf } from './pools.js';
import { isLocalDex, loadLocalPool, staticKeysFor, warmPumpTemplates } from './build.js';
import { ensureAlt } from './alt.js';
import { startBlockhashPump, blockhashAgeMs } from './hot.js';
import { startWire } from './wire.js';
import {
  BASE_FEES_LAMPORTS,
  execute,
  fmtSol,
  loadWallet,
  planTrade,
  reclaimEmptyTokenAccounts,
  setAlt,
} from './executor.js';
import { getTipFloor } from './jito.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function lockedRent(conn: Connection, wallet: { publicKey: import('@solana/web3.js').PublicKey }): Promise<number> {
  let sum = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await conn.getTokenAccountsByOwner(wallet.publicKey, { programId }).catch(() => null);
    for (const a of r?.value ?? []) sum += a.account.lamports;
  }
  return sum;
}
const ts = () => new Date().toISOString().slice(11, 19);

async function main() {
  console.log(
    `sol-arb-scout | mode=${CFG.dryRun ? 'DRY RUN (paper)' : 'LIVE'} | ` +
      `size=${CFG.tradeSizeSol} SOL | slippage=${CFG.slippageBps} bps | ` +
      `gate: worst-case net ≥ ${CFG.minNetLamports} lamports after tip+${BASE_FEES_LAMPORTS} fees | ` +
      `${Object.keys(TOKENS).length} tokens`,
  );
  if (!CFG.dryRun) {
    console.log(
      'LIVE MODE: burner wallet, a few dollars max. Expect to lose the race' +
        ' on free-tier RPC — that IS the lesson. Ctrl+C to stop.',
    );
  }

  const conn = new Connection(CFG.rpcUrl, 'confirmed');
  startWire();              // warm TLS sockets to every Jito region (~100ms off each submit)
  startBlockhashPump(conn); // keeps a fresh blockhash ready so firing costs no RPC
  const wallet = CFG.dryRun ? null : loadWallet();
  let startBal = 0;
  if (wallet) {
    // Reclaim any rent left over from earlier runs, then baseline the balance.
    await reclaimEmptyTokenAccounts(conn, wallet).catch(() => 0);
    startBal = await conn.getBalance(wallet.publicKey);
    console.log(`wallet ${wallet.publicKey.toBase58()} | balance ${fmtSol(startBal)} SOL`);
  }
  const floor0 = await getTipFloor();
  console.log(`jito tip floor now: p25=${floor0.p25} p50=${floor0.p50} p75=${floor0.p75} lamports`);

  // On-chain signal: a token's live cross-pool spread crossed its trigger.
  // Ask Jupiter for the executable round trip *now* and run the same gate.
  // Hybrid: a PumpSwap leg is built locally (no API call); other legs via Jupiter.
  const onSignal = async (book: TokenBook): Promise<SignalResult> => {
    // Size chosen by the local optimiser for THIS dislocation (capped by TRADE_SIZE_SOL).
    const inL = BigInt(book.localSizeLamports ?? Math.floor(CFG.tradeSizeSol * 1e9));
    const slip = (x: bigint) => (x * BigInt(10_000 - CFG.slippageBps)) / 10_000n;
    const buyLocal = CFG.localBuild && !!book.localBuy && isLocalDex(book.localBuy.dex, book.localBuy.token2022);
    const sellLocal = CFG.localBuild && !!book.localSell && isLocalDex(book.localSell.dex, book.localSell.token2022);
    let legA: Quote | null = null, tokAmount: bigint;
    if (buyLocal) {
      const t = swapOut(book.localBuy!, SOL, Number(inL));
      if (!t) return null;
      tokAmount = BigInt(Math.floor(t));
    } else {
      legA = await quote(SOL, book.mint, inL);
      if (!legA) return null;
      tokAmount = BigInt(legA.outAmount);
    }
    // legB is fed exactly what legA is GUARANTEED to deliver. That guarantee is
    // legA's on-chain minimum, so it needs a real buffer (BUY_BUFFER_BPS) or the
    // buy reverts on any tick of movement — which is what killed several fires.
    // Profitability is then judged on this reduced amount, so the gate stays honest.
    const buf = (x: bigint) => (x * BigInt(10_000 - CFG.buyBufferBps)) / 10_000n;
    const sellIn = buyLocal ? buf(tokAmount) : tokAmount;
    let legB: Quote | null = null, out: bigint, minOut: bigint;
    if (sellLocal) {
      const o = swapOut(book.localSell!, book.mint, Number(sellIn));
      if (!o) return null;
      out = BigInt(Math.floor(o)); minOut = slip(out);
    } else {
      legB = await quote(book.mint, SOL, sellIn);
      if (!legB) return null;
      out = BigInt(legB.outAmount); minOut = BigInt(legB.otherAmountThreshold);
    }
    const opp: Opportunity = {
      symbol: book.symbol, mint: book.mint, inLamports: inL, outLamports: out, minOutLamports: minOut,
      edgeBps: Number(((out - inL) * 10_000n) / inL), legA, legB,
      localBuy: buyLocal ? book.localBuy : undefined, localSell: sellLocal ? book.localSell : undefined, tokAmount,
    };
    if (opp.edgeBps >= CFG.minProfitBps) await onCandidate(opp, 'watch');
    return { edgeBps: opp.edgeBps, legA: legA ?? undefined, legB: legB ?? undefined };
  };
  if (CFG.watch) {
    console.log('starting on-chain pool watcher (WATCH=true)…');
    startWatcher(conn, onSignal)
      .then(async () => {
        if (!wallet || !CFG.localBuild) return;
        // Address lookup table over every local pool's static accounts so a full
        // round trip fits in ONE transaction. One-time rent, reclaimable.
        // Never put tip accounts in the ALT (Jito requires them static).
        // Order pools cheapest-fee-first: those are the ones that can actually
        // clear a fee wall and fire, so they get the limited table space.
        const ranked = [...books.values()]
          .flatMap((b) => b.pools.filter((p) => isLocalDex(p.dex, p.token2022)))
          .map((p) => ({ p, fee: modelOf(p)?.fee ?? 1 }))
          .sort((a, b) => a.fee - b.fee);
        const keys: import('@solana/web3.js').PublicKey[] = [];
        for (const { p } of ranked) {
          try { keys.push(...staticKeysFor(await loadLocalPool(conn, p.dex, p.address), wallet.publicKey)); } catch { /* skip pool */ }
        }
        setAlt(await ensureAlt(conn, wallet, keys));
        // PumpSwap CPI templates (from Jupiter+simulation): warm now, refresh every 4 min.
        const pumpPools = [...books.values()].flatMap((b) => b.pools.filter((p) => p.dex === 'pumpswap'));
        await warmPumpTemplates(conn, wallet.publicKey, pumpPools);
        setInterval(() => void warmPumpTemplates(conn, wallet.publicKey, pumpPools, true), 240_000);

        // ---- hourly token rotation, ranked by fee wall ----
        // The long tail is where tradeable edges actually exist and it turns over,
        // so re-screen the market on an interval and adopt anything cheaper to
        // round-trip than what we hold. Nothing is dropped while it is producing.
        if (CFG.discoverEnabled) {
          const rotate = async () => {
            try {
              const have = new Set([...books.values()].map((b) => b.mint));
              const found = await screenTokens(conn, have);
              if (!found.length) { console.log('  rotation: no new token beat the fee-wall threshold'); return; }
              let added = 0;
              for (const c of found) {
                if (books.size >= CFG.discoverMaxTokens) break;
                const sym = c.symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || c.mint.slice(0, 6);
                if (books.has(sym)) continue;
                if (await addToken(conn, sym, c.mint, onSignal)) {
                  added++;
                  console.log(`  rotation + ${sym}: fee wall ${c.wall.toFixed(0)} bps, ${c.pools} pools, $${(c.liqUsd / 1e6).toFixed(1)}M liq`);
                }
              }
              // Make room by dropping the worst performers (no signals, worst edge).
              if (books.size >= CFG.discoverMaxTokens) {
                const ranked = [...books.values()]
                  .filter((b) => b.signals === 0)
                  .sort((a, b) => (a.localEdgeBps || -1e9) - (b.localEdgeBps || -1e9));
                for (const b of ranked.slice(0, Math.max(0, books.size - CFG.discoverMaxTokens + 2))) {
                  if (dropToken(conn, b.symbol)) console.log(`  rotation - ${b.symbol}: no signals, best edge ${b.localEdgeBps.toFixed(0)} bps`);
                }
              }
              console.log(`  rotation done: ${added} added, watching ${books.size} tokens`);
            } catch (e) { console.warn('  rotation failed:', (e as Error).message.slice(0, 100)); }
          };
          setTimeout(() => void rotate(), 120_000);            // first pass shortly after startup
          setInterval(() => void rotate(), CFG.discoverIntervalMs);
        }
      })
      .catch((e) => console.warn('watcher failed to start:', (e as Error).message));
  }

  let scans = 0, hits = 0, sent = 0, landed = 0;
  let bestSeen = -Infinity;
  let bestNet = -Infinity;
  let errStreak = 0;
  // Per-token in-flight tracking only — no global serialisation (see watch.ts).
  // Committed capital is tracked so simultaneous trades can never overdraw the
  // wallet: each in-flight bundle reserves its input until it resolves.
  const inflightByToken = new Set<string>();
  let committedLamports = 0;
  let lastBalanceLog = 0;
  const reportBalance = async (force = false) => {
    if (!wallet) return;
    if (!force && Date.now() - lastBalanceLog < 5000) return;
    lastBalanceLog = Date.now();
    try {
      const bal = await conn.getBalance(wallet.publicKey);
      const rent = await lockedRent(conn, wallet);
      const d = bal + rent - startBal;
      console.log(`  balance ${fmtSol(bal)} SOL${rent ? ` (+${fmtSol(rent)} rent locked)` : ''} | session P&L ${d >= 0 ? '+' : ''}${fmtSol(d)} SOL | sent ${sent} landed ${landed}`);
    } catch (e) {
      console.warn('  balance check failed:', (e as Error).message.slice(0, 80));
    }
  };

  async function onCandidate(opp: Opportunity, source: 'poll' | 'watch' = 'poll'): Promise<void> {
    // Poll-path hits on tokens the on-chain engine covers must be backed by local math
    // (forensics: unbacked poll hits were phantom edges from Jupiter's cache).
    if (source === 'poll' && books.has(opp.symbol)) {
      const loc = await localRoundTrip(conn, opp.symbol).catch(() => null);
      if (loc && Number.isFinite(loc.best) && loc.best < CFG.pollAgreeBps) {
        console.log(`${ts()} ${opp.symbol.padEnd(6)} jupiter +${opp.edgeBps} bps but local says ${loc.best.toFixed(1)} — phantom, skip`);
        return;
      }
    }
    const plan = planTrade(opp, await getTipFloor());
    const line =
      `${ts()} ${opp.symbol.padEnd(6)} edge ${String(opp.edgeBps).padStart(4)} bps` +
      ` | worst-case gross ${fmtSol(opp.minOutLamports - opp.inLamports)} SOL`;
    if (!plan) {
      // Positive on paper, but not after tip+fees at worst-case fill. Log the near-miss.
      const need = BigInt(BASE_FEES_LAMPORTS + (await getTipFloor()).p25 + CFG.minNetLamports);
      const short = need - (opp.minOutLamports - opp.inLamports);
      console.log(`${line} | short by ${fmtSol(short)} SOL of tip+fees — skip`);
      return;
    }
    hits++;
    if (Number(plan.netWorstLamports) > bestNet) bestNet = Number(plan.netWorstLamports);
    console.log(
      `${line} | tip ${plan.tipLamports}@${plan.tipRung} | WORST-CASE NET +${fmtSol(plan.netWorstLamports)} SOL` +
        ` (expected +${fmtSol(plan.grossExpectedLamports - BigInt(plan.tipLamports + BASE_FEES_LAMPORTS))})  << TRADEABLE`,
    );
    if (CFG.dryRun || !wallet) {
      console.log('  (dry run — would send bundle)');
      return;
    }
    if (inflightByToken.has(opp.symbol)) { console.log(`  (${opp.symbol} bundle already in flight — skip)`); return; }
    if (inflightByToken.size >= CFG.maxInflight) { console.log(`  (${inflightByToken.size} bundles in flight — skip)`); return; }
    // Parallel trades must not overdraw the wallet: reserve this trade's input
    // (plus fees/tip headroom) against the free balance before firing.
    const need = Number(opp.inLamports) + plan.tipLamports + BASE_FEES_LAMPORTS + 5_000_000; // keep ~0.005 SOL spare
    const free = (await conn.getBalance(wallet.publicKey).catch(() => 0)) - committedLamports;
    if (free < need) { console.log(`  (${opp.symbol} skipped: ${fmtSol(free)} SOL free vs ${fmtSol(need)} needed with ${inflightByToken.size} in flight)`); return; }
    committedLamports += need;
    inflightByToken.add(opp.symbol);
    try {
      sent++;
      const res = await execute(conn, wallet, opp, plan);
      if (res.status !== 'sent') { console.log(`  ✗ ${res.detail}`); inflightByToken.delete(opp.symbol); committedLamports -= need; return; }
      res.landing!
        .then(async (fin) => {
          if (fin.status === 'landed') { landed++; console.log(`  ✅ LANDED ${opp.symbol} (${fin.detail})`); await reportBalance(true); }
          else if (fin.status === 'dropped') console.log(`  ✗ ${opp.symbol} bundle not landed — lost the race, cost 0`);
          else console.log(`  ✗ ${opp.symbol}: ${fin.detail}`);
        })
        .catch((e) => console.warn('  landing check failed:', (e as Error).message.slice(0, 80)))
        .finally(() => { inflightByToken.delete(opp.symbol); committedLamports -= need; });
    } catch (e) {
      console.error('  execute failed:', (e as Error).message);
      inflightByToken.delete(opp.symbol); committedLamports -= need;
    }
  }

  for (;;) {
    try {
      // Only poll what the on-chain watcher does NOT cover. Polling a covered token
      // spends Jupiter quota to reproduce (worse, staler) what local pricing already
      // knows, and was the source of every phantom signal.
      const opps = await scanOnce(onCandidate, CFG.watch ? (sym) => !books.has(sym) : undefined);
      scans++;
      errStreak = 0;
      const top = opps[0];
      if (top && top.edgeBps > bestSeen) bestSeen = top.edgeBps;
      // The watcher, not the poll loop, is the engine now — so report on every
      // cycle even when nothing was polled (all tokens covered locally).
      if (scans % 5 === 0) {
        const floor = await getTipFloor();
        const need = BASE_FEES_LAMPORTS + floor.p25 + CFG.minNetLamports;
        const sizeRef = Number(top?.inLamports ?? Math.floor(CFG.tradeSizeSol * 1e9));
        const needBps = Math.ceil((need * 10_000) / sizeRef) + CFG.slippageBps;
        let bal = '';
        if (wallet) {
          if (scans % 200 === 0) await reclaimEmptyTokenAccounts(conn, wallet).catch(() => 0);
          try {
            const b = await conn.getBalance(wallet.publicKey);
            const rent = await lockedRent(conn, wallet);
            const d = b + rent - startBal;
            bal = ` | bal ${fmtSol(b)}${rent ? `+${fmtSol(rent)}rent` : ''} (${d >= 0 ? '+' : ''}${fmtSol(d)})`;
          } catch { bal = ' | bal ?'; }
        }
        // Best live local edge across every watched token (what actually fires).
        let lead = '', leadBps = -Infinity, leadSize = 0;
        for (const b of books.values()) {
          if (Number.isFinite(b.localEdgeBps) && b.localEdgeBps > leadBps) {
            leadBps = b.localEdgeBps; lead = b.symbol; leadSize = b.localSizeLamports ?? 0;
          }
        }
        console.log(
          `${ts()} #${scans} best-local ${lead.padEnd(6)} ${leadBps === -Infinity ? '   -' : leadBps.toFixed(0).padStart(4)} bps` +
            `${leadSize ? ` @${(leadSize / 1e9).toFixed(3)}` : ''}` +
            (top ? ` | polled ${top.symbol} ${top.edgeBps} bps` : ' | polled none (all covered locally)') +
            ` | need ≈ ${needBps} bps | tradeable ${hits} sent ${sent} landed ${landed} | req ${laneStats()}${bal}`,
        );
        if (books.size) {
          const ev = [...books.values()].reduce((a, b) => a + b.updates, 0);
          const sig = [...books.values()].reduce((a, b) => a + b.signals, 0);
          console.log(`         local round-trip bps: ${watchSummary()} | events ${ev} signals ${sig} | blockhash ${(blockhashAgeMs() / 1000).toFixed(1)}s old`);
        }
      }
    } catch (e) {
      errStreak++;
      console.error('scan error:', (e as Error).message);
      if (errStreak >= 10) {
        console.error('10 consecutive failures — check RPC_URL / JUP_BASE in .env. Exiting.');
        process.exit(1);
      }
    }
    await sleep(CFG.scanIntervalMs);
  }
}

// Never let a background hiccup (RPC 429 in a callback, WS blip) kill the bot.
process.on('unhandledRejection', (e) => console.error('  [unhandled rejection]', (e as Error)?.message ?? e));
process.on('uncaughtException', (e) => console.error('  [uncaught exception]', e.message));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
