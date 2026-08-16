import { Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CFG } from './config.js';
import { scanOnce, tierCounts, type Opportunity } from './scanner.js';
import { laneStats, quote, type Quote } from './jupiter.js';
import { SOL, TOKENS } from './tokens.js';
import { startWatcher, addToken, dropToken, watchSummary, books, localRoundTrip, type TokenBook, type SignalResult, type SignalMode } from './watch.js';
import { screenTokens } from './discover.js';
import { swapOut, modelOf } from './pools.js';
import { isLocalDex, loadLocalPool, staticKeysFor, warmPumpTemplates, hasPumpTemplate } from './build.js';
import { ensureAlt } from './alt.js';
import { startBlockhashPump, blockhashAgeMs, startBalancePump, hotBalance, nudgeBalance } from './hot.js';
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

// SOL value of a raw token amount, from the watcher's live pool prices. null if
// we do not price this mint (then the sweeper leaves any non-trivial balance alone).
function valueSol(mint: string, rawAmount: bigint): number | null {
  for (const b of books.values()) {
    if (b.mint !== mint) continue;
    const priced = b.pools.filter((p) => p.ok && p.price && p.price > 0);
    if (!priced.length) return null;
    const px = Math.max(...priced.map((p) => p.price!)); // SOL per whole token, UI units
    const dec = priced[0].decimals;
    return (Number(rawAmount) / 10 ** dec) * px;
  }
  return null;
}

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
  setInterval(() => void getTipFloor(), 15_000); // keep the tip floor cache warm (it caches 20s)
  const wallet = CFG.dryRun ? null : loadWallet();
  let startBal = 0;
  if (wallet) {
    // Reclaim any rent left over from earlier runs, then baseline the balance.
    await reclaimEmptyTokenAccounts(conn, wallet, undefined, valueSol).catch(() => 0);
    startBal = await conn.getBalance(wallet.publicKey);
    startBalancePump(conn, wallet.publicKey); // firing path reads a cached balance, never RPC
    console.log(`wallet ${wallet.publicKey.toBase58()} | balance ${fmtSol(startBal)} SOL`);
  }
  const floor0 = await getTipFloor();
  console.log(`jito tip floor now: p25=${floor0.p25} p50=${floor0.p50} p75=${floor0.p75} lamports`);

  // On-chain signal: a token's live cross-pool spread crossed its trigger.
  // Ask Jupiter for the executable round trip *now* and run the same gate.
  // Hybrid: a PumpSwap leg is built locally (no API call); other legs via Jupiter.
  const onSignal = async (book: TokenBook, mode: SignalMode = 'local'): Promise<SignalResult> => {
    // Size chosen by the local optimiser for THIS dislocation (capped by TRADE_SIZE_SOL).
    const inL = BigInt(book.localSizeLamports ?? Math.floor(CFG.tradeSizeSol * 1e9));
    const slip = (x: bigint) => (x * BigInt(10_000 - CFG.slippageBps)) / 10_000n;
    // A leg is built locally only if (a) we're in local mode, (b) the venue is one
    // we encode for this token standard, and (c) for PumpSwap, a fresh CPI
    // template exists — otherwise the leg goes to Jupiter, never to a stale layout.
    const canLocal = (p: typeof book.localBuy) =>
      !!p && CFG.localBuild && mode === 'local' && isLocalDex(p.dex, p.token2022) && (p.dex !== 'pumpswap' || hasPumpTemplate(p.address));
    const buyLocal = canLocal(book.localBuy);
    const sellLocal = canLocal(book.localSell);
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
    // This applies to a Jupiter-built legA too: its quoted outAmount is an
    // expectation, and legB transfers exactly what we say — so legB must be sized
    // to what legA is guaranteed to deliver, and the executor loosens legA's
    // on-chain minimum to that same buffered amount.
    const buf = (x: bigint) => (x * BigInt(10_000 - CFG.buyBufferBps)) / 10_000n;
    const sellIn = buf(tokAmount);
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
        // Table space goes where it changes the outcome: PumpSwap pools FIRST — a
        // pump leg references ~26 accounts and pump<->DLMM round trips only fit in
        // one transaction with those in the table (DLMM<->DLMM fits without it).
        // Then cheapest-fee-first for whatever budget remains.
        const ranked = [...books.values()]
          .flatMap((b) => b.pools.filter((p) => isLocalDex(p.dex, p.token2022)))
          .map((p) => ({ p, fee: modelOf(p)?.fee ?? 1, pump: p.dex === 'pumpswap' ? 0 : 1 }))
          .sort((a, b) => a.pump - b.pump || a.fee - b.fee);
        // PumpSwap CPI templates FIRST (from Jupiter+simulation) so the lookup table
        // below can include the exact accounts a pump leg references — that is what
        // lets a pump<->DLMM round trip fit in ONE transaction instead of a 2-tx bundle.
        const livePumpPools = () => [...books.values()].flatMap((b) => b.pools.filter((p) => p.dex === 'pumpswap'));
        await warmPumpTemplates(conn, wallet.publicKey, livePumpPools());
        const keys: import('@solana/web3.js').PublicKey[] = [];
        for (const { p } of ranked) {
          try { keys.push(...staticKeysFor(await loadLocalPool(conn, p.dex, p.address), wallet.publicKey)); } catch { /* skip pool */ }
        }
        setAlt(await ensureAlt(conn, wallet, keys));
        // Refresh over the LIVE list so pools adopted by rotation are covered too.
        setInterval(() => void warmPumpTemplates(conn, wallet.publicKey, livePumpPools(), true), 240_000);

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
                  // New PumpSwap pools need their CPI template before they can build locally.
                  const b = books.get(sym);
                  if (b) await warmPumpTemplates(conn, wallet.publicKey, b.pools.filter((p) => p.dex === 'pumpswap'));
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
    // Any quote claiming a multiple of the input is a data fault, not a windfall.
    // This applies to EVERY token — the local-agreement check below only covers
    // tokens the watcher tracks, and XST slipped through it after being dropped.
    if (opp.outLamports > opp.inLamports * 2n) {
      console.warn(`${ts()} ${opp.symbol.padEnd(6)} implausible quote (${(Number(opp.outLamports) / Number(opp.inLamports)).toFixed(1)}x) — ignoring`);
      return;
    }
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
    // Cached balance (background pump) — no RPC round trip in the firing path.
    // If the pump has never succeeded (-1), fall back to one live read.
    const known = hotBalance();
    const free = (known >= 0 ? known : await conn.getBalance(wallet.publicKey).catch(() => 0)) - committedLamports;
    if (free < need) { console.log(`  (${opp.symbol} skipped: ${fmtSol(free)} SOL free vs ${fmtSol(need)} needed with ${inflightByToken.size} in flight)`); return; }
    committedLamports += need;
    inflightByToken.add(opp.symbol);
    try {
      sent++;
      const res = await execute(conn, wallet, opp, plan);
      if (res.status !== 'sent') { console.log(`  ✗ ${res.detail}`); inflightByToken.delete(opp.symbol); committedLamports -= need; return; }
      res.landing!
        .then(async (fin) => {
          if (fin.status === 'landed') { landed++; console.log(`  ✅ LANDED ${opp.symbol} (${fin.detail})`); nudgeBalance(conn, wallet.publicKey); await reportBalance(true); }
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
          if (scans % 200 === 0) { await reclaimEmptyTokenAccounts(conn, wallet, undefined, valueSol).catch(() => 0); nudgeBalance(conn, wallet.publicKey); }
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
