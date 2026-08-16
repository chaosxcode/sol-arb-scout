import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  createCloseAccountInstruction,
  unpackAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { CFG } from './config.js';
import { buildSwapTx } from './jupiter.js';
import { sendBundle, TIP_ACCOUNTS, type TipFloor } from './jito.js';
import { isLocalDex, loadLocalPool, buildRoundTripTx, buildLegTx } from './build.js';
import { hotBlockhash } from './hot.js';
import type { Opportunity } from './scanner.js';

export function loadWallet(): Keypair {
  const raw = JSON.parse(readFileSync(CFG.walletKeypair, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ---- Fee math ---------------------------------------------------------------
// A "hit" only counts if the WORST-CASE fill (legB's on-chain minimum out)
// still beats every lamport we spend to get it. Costs:
//   base fees: 2 txs x 5000 (legA, legB) + 5000 for the post-trade ATA close
//   tip:       chosen from Jito's live floor — the highest percentile we can
//              afford while staying net-positive (higher tip = better odds)
export const BASE_FEES_LAMPORTS = 10_000; // 2 txs x 5000; ATA rent is swept periodically, not per trade

export interface Plan {
  tipLamports: number;
  tipRung: 'p95' | 'p75' | 'p50' | 'p25' | 'bid';
  grossWorstLamports: bigint;  // minOut - in
  grossExpectedLamports: bigint; // out - in
  netWorstLamports: bigint;    // grossWorst - tip - fees
}

// Tip = a fixed share of the worst-case profit (Jito is an auction; winners
// bid most of the edge), snapped up to the nearest landed-tip percentile when
// that still fits. Never below what leaves MIN_NET_LAMPORTS.
export function planTrade(opp: Opportunity, floor: TipFloor): Plan | null {
  // A round trip cannot plausibly return many multiples of its input. When the
  // local model emits something like +3,586,618 bps (observed on XST), that is a
  // pricing fault — stale bin data, a decimals mismatch, an empty reserve — not
  // a windfall. Refuse it loudly rather than spend a send on garbage.
  if (opp.outLamports > opp.inLamports * BigInt(1 + CFG.sanityMaxMultiple)) {
    console.warn(`  ⚠ ${opp.symbol}: implausible quote (${(Number(opp.outLamports) / Number(opp.inLamports)).toFixed(1)}x return) — pricing fault, ignoring`);
    return null;
  }
  const grossWorst = opp.minOutLamports - opp.inLamports;
  const grossExpected = opp.outLamports - opp.inLamports;
  const room = grossWorst - BigInt(BASE_FEES_LAMPORTS) - BigInt(CFG.minNetLamports);
  if (room <= 0n) return null;
  // Jito is an auction. Bidding a flat 15k into an opportunity worth 600k+ is
  // how you lose to someone bidding 60% of it — the flat cap came from majors
  // forensics (tiny edges, 1-15k tips) and is the wrong reference for a fat
  // long-tail edge. Bid a SHARE of the actual profit; the cap is only a floor-
  // level sanity bound for tiny trades, applied as a maximum of the two.
  const share = Number((room * BigInt(Math.round(CFG.tipShare * 100))) / 100n);
  const budget = Math.max(Math.min(CFG.tipMaxLamports, share), Math.min(share, CFG.tipCeilingLamports));
  let tip = Math.max(1000, Math.floor(budget)); let tipRung: Plan['tipRung'] = 'bid';
  for (const [r, v] of [['p95', floor.p95], ['p75', floor.p75], ['p50', floor.p50], ['p25', floor.p25]] as const) {
    if (v <= budget && v > tip) { tip = v; tipRung = r; }
  }
  if (tip > Number(room)) return null;
  const net = grossWorst - BigInt(tip) - BigInt(BASE_FEES_LAMPORTS);
  if (net < BigInt(CFG.minNetLamports)) return null;
  return { tipLamports: tip, tipRung, grossWorstLamports: grossWorst, grossExpectedLamports: grossExpected, netWorstLamports: net };
}

// Loosen a Jupiter quote's on-chain minimum to `floor` (break-even) without
// touching anything else in the route. Never tightens, never goes below floor.
function relaxThreshold(q: NonNullable<Opportunity['legB']>, floor: bigint): NonNullable<Opportunity['legB']> {
  const current = BigInt(q.otherAmountThreshold ?? 0);
  if (current <= floor) return q; // already at least as permissive as break-even
  const out = BigInt(q.outAmount);
  const impliedBps = out > 0n ? Number(((out - floor) * 10_000n) / out) : q.slippageBps;
  return { ...q, otherAmountThreshold: floor.toString(), slippageBps: Math.max(0, Math.min(9999, impliedBps)) };
}

export const fmtSol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');

// ---- Execution ----------------------------------------------------------------
export interface Result {
  status: 'landed' | 'dropped' | 'error' | 'sent';
  bundleId?: string;
  detail?: string;
  // resolves once we know whether it landed (checked on-chain via legB's signature)
  landing?: Promise<Result>;
}

export async function execute(
  conn: Connection,
  wallet: Keypair,
  opp: Opportunity,
  plan: Plan,
): Promise<Result> {
  const user = wallet.publicKey.toBase58();
  // Each leg is built either LOCALLY (PumpSwap, src/build.ts — zero API calls)
  // or by Jupiter. legA: no priority fee. legB carries the Jito tip (embedded
  // by Jupiter, or an explicit transfer appended to a local tx).
  const localA = CFG.localBuild && !opp.legA && !!opp.localBuy && isLocalDex(opp.localBuy.dex, opp.localBuy.token2022);
  const localB = CFG.localBuild && !opp.legB && !!opp.localSell && isLocalDex(opp.localSell.dex, opp.localSell.token2022);
  if ((!opp.legA && !localA) || (!opp.legB && !localB)) return { status: 'error', detail: 'no way to build a leg' };
  // ---- On-chain minimum-out: the BREAK-EVEN floor, not a tight track of our estimate.
  // We were setting min-out to (local estimate - SLIPPAGE_BPS), so a trade died if
  // reality came in 1 bp under forecast — even when it was still clearly profitable.
  // What we actually require is only that the round trip does not LOSE money: any
  // fill above (input + tip + fees + min profit) is a win worth taking. This fails
  // the trade exactly when it would be unprofitable and never sooner, which is the
  // whole point of an atomic bundle. (ExceededAmountSlippageTolerance, 2026-08-16.)
  const breakEvenOut = opp.inLamports + BigInt(plan.tipLamports + BASE_FEES_LAMPORTS + CFG.minNetLamports);
  const floorOut = breakEvenOut < opp.minOutLamports ? breakEvenOut : opp.minOutLamports;
  const needBh = localA || localB;
  const bhP = needBh ? hotBlockhash(conn).then((blockhash) => ({ blockhash })) : null;
  // Same buffered intermediate amount the signal used to judge profitability:
  // legA must deliver at least this, and legB sells exactly this.
  const slip = (x: bigint) => (x * BigInt(10_000 - CFG.buyBufferBps)) / 10_000n;
  // A Jupiter-built leg bakes the quote's `otherAmountThreshold` in as its
  // on-chain minimum. Quoted at SLIPPAGE_BPS=1 that reverts (Jupiter 0x1789)
  // on any tick of movement. Rewrite the threshold on the FINAL leg to the same
  // break-even floor we use for local legs: revert only if we'd lose money.
  const legBForBuild = opp.legB && !localB ? relaxThreshold(opp.legB, floorOut) : opp.legB;
  const [aRes, bRes, bh] = await Promise.all([
    localA ? null : buildSwapTx(opp.legA!, user, 0),
    localB ? null : buildSwapTx(legBForBuild!, user, { jitoTipLamports: plan.tipLamports }),
    bhP,
  ]);
  const txs: VersionedTransaction[] = [];
  // Both legs local -> try ONE atomic transaction (fee once, one simulation at
  // Jito's auction). Falls back to a 2-tx bundle if it doesn't fit.
  if (localA && localB) {
    try {
      const [ba, sa] = await Promise.all([loadLocalPool(conn, opp.localBuy!.dex, opp.localBuy!.address), loadLocalPool(conn, opp.localSell!.dex, opp.localSell!.address)]);
      const one = await buildRoundTripTx(conn, wallet, ba, sa, opp.inLamports, slip(opp.tokAmount!), floorOut, plan.tipLamports, new PublicKey(TIP_ACCOUNTS[1]) /* not in the ALT: Jito needs the tip account as a STATIC key */, bh!.blockhash, altTable);
      if (one) {
        console.log(`  legs: SINGLE TX ${opp.localBuy!.dex}→${opp.localSell!.dex} (${one.serialize().length} B${altTable ? ', ALT' : ''})`);
        return sendAndTrack(conn, [one], plan);
      }
    } catch (e) {
      console.warn('  single-tx compose failed, using bundle:', (e as Error).message.slice(0, 80));
    }
  }
  const buildLocal = async (pool: NonNullable<typeof opp.localBuy>, side: 'buy' | 'sell', amountIn: bigint, minOut: bigint, extra: import('@solana/web3.js').TransactionInstruction[]) =>
    buildLegTx(conn, wallet, await loadLocalPool(conn, pool.dex, pool.address), side, amountIn, minOut, bh!.blockhash, extra);
  if (localA) {
    txs.push(await buildLocal(opp.localBuy!, 'buy', opp.inLamports, slip(opp.tokAmount!), []));
  } else {
    if (!aRes) return { status: 'error', detail: 'Jupiter legA build failed' };
    const tx = VersionedTransaction.deserialize(Buffer.from(aRes, 'base64')); tx.sign([wallet]); txs.push(tx);
  }
  if (localB) {
    const tipIx = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(TIP_ACCOUNTS[1]) /* not in the ALT: Jito needs the tip account as a STATIC key */, lamports: plan.tipLamports });
    txs.push(await buildLocal(opp.localSell!, 'sell', slip(opp.tokAmount!), floorOut, [tipIx]));
  } else {
    if (!bRes) return { status: 'error', detail: 'Jupiter legB build failed' };
    const tx = VersionedTransaction.deserialize(Buffer.from(bRes, 'base64')); tx.sign([wallet]); txs.push(tx);
  }
  if (localA || localB) console.log(`  legs: A=${localA ? 'LOCAL ' + opp.localBuy!.dex : 'jupiter'} B=${localB ? 'LOCAL ' + opp.localSell!.dex : 'jupiter'}`);
  return sendAndTrack(conn, txs, plan, opp);
}

export let altTable: import('@solana/web3.js').AddressLookupTableAccount | null = null;
export const setAlt = (t: typeof altTable) => { altTable = t; };

async function sendAndTrack(conn: Connection, txs: VersionedTransaction[], plan: Plan, opp?: Opportunity): Promise<Result> {
  if (!CFG.useJito) {
    // Non-atomic fallback — legs can strand you in the mid-token. Jito preferred.
    for (const t of txs) {
      const sig = await conn.sendRawTransaction(t.serialize(), { skipPreflight: false });
      console.log('  sent (non-atomic):', sig);
    }
    return { status: 'landed', detail: 'non-atomic sends (unverified)' };
  }

  // legB is the last tx in the bundle; bundles are all-or-nothing, so legB's
  // signature confirming on-chain == the whole round trip landed. We check the
  // chain directly (Jito's status API lags / reports "Invalid" for not-yet-
  // indexed bundles — it fooled us once).
  const sigB = bs58.encode(txs[txs.length - 1].signatures[0]); // last tx = the one that must land
  let bundleId: string;
  try {
    bundleId = await sendBundle(txs.map((t) => bs58.encode(t.serialize())));
  } catch (e) {
    const msg = (e as Error).message;
    const labels = (q: Opportunity['legA'] | undefined) => q ? ((q.routePlan as Array<{ swapInfo: { label?: string } }> | undefined) ?? []).map((h) => h.swapInfo.label).join('>') : 'local';
    if (msg.includes('vote accounts')) {
      console.warn(`  Jito refused (vote account in route). legA [${labels(opp?.legA)}] legB [${labels(opp?.legB)}] — add the offending DEX to JUP_EXCLUDE_DEXES`);
    }
    return { status: 'error', detail: msg };
  }
  console.log(`  bundle ${bundleId.slice(0, 12)}… submitted (${txs.length} tx, tip ${plan.tipLamports} lamports @${plan.tipRung}); waiting for ${sigB.slice(0, 10)}…`);
  // Learn why misses miss: simulate the fired tx(s) against current state,
  // asynchronously (no latency cost), and log the program error if any.
  void (async () => {
    try {
      // Simulate txs[0], never the last one. For a single-tx round trip that IS
      // the whole trade. For a 2-tx bundle, legB cannot be simulated standalone —
      // it sells tokens that only exist after legA runs, so it always reports a
      // bogus "insufficient funds". legA is the honest standalone check.
      const probe = txs[0];
      const what = txs.length === 1 ? 'the round-trip tx' : 'legA (legB is not standalone-simulatable)';
      const sim = await conn.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
      if (sim.value.err) {
        const logs = (sim.value.logs ?? []).filter((l) => /Error|error|failed|Custom|Program log: (Instruction|AnchorError)/.test(l)).slice(-4);
        // This probe runs a moment AFTER submission, so it reflects state that has
        // already moved on. A slippage revert therefore means "the edge evaporated
        // before we could be simulated" — expected for a short-lived opportunity,
        // NOT a defect. Structural errors (bad accounts, wrong program, missing
        // remaining-account) fail regardless of state and ARE defects. Label them
        // differently so a transient miss never sends anyone hunting a phantom bug.
        const blob = JSON.stringify(sim.value.err) + logs.join(' ');
        // Every DEX spells "minimum not met" differently. All of these are the same
        // state-dependent condition — the edge moved between build and this probe —
        // not a defect in how we encode the transaction:
        //   Meteora DLMM  6003  ExceededAmountSlippageTolerance
        //   PumpSwap      6040  BuySlippageBelowMinBaseAmountOut
        //   PumpSwap      6041  SellSlippageExceedsMaxQuoteAmountOut (observed variant)
        //   Jupiter       6025 / 0x1789  SlippageToleranceExceeded
        //   Whirlpool/CLMM 6003 / 0x1793 AmountOutBelowMinimum
        const transient = /6003|6040|6041|6025|0x1789|0x1793|Slippage|slippage|AmountOutBelowMinimum|ExceededAmount|insufficient funds/.test(blob);
        const tag = transient ? 'edge gone by sim time (transient, expected on a miss)' : '*** STRUCTURAL — investigate ***';
        console.log(`  post-send sim of ${what}: ${tag} ${JSON.stringify(sim.value.err)} :: ${logs.join(' | ').slice(0, 240)}`);
      } else {
        console.log(`  post-send sim of ${what}: OK (CU ${sim.value.unitsConsumed}) — state still valid; miss = auction/latency`);
      }
    } catch (e) { console.log('  post-send sim failed:', (e as Error).message.slice(0, 80)); }
  })();
  const landing = trackSignature(conn, sigB, 12_000).then((st): Result => {
    if (st.status === 'landed') return { status: 'landed', bundleId, detail: `slot ${st.slot} sig ${sigB}` };
    if (st.status === 'failed') return { status: 'error', bundleId, detail: `legB landed but errored: ${st.err}` };
    return { status: 'dropped', bundleId, detail: 'not on chain after 12s' };
  });
  return { status: 'sent', bundleId, landing };
}

// ---- In-flight registry: ONE getSignatureStatuses call per tick for every
// pending bundle, however many are out. (Per-bundle polling melted the free
// RPC tier during a burst.) A bundle lands within a few slots or never.
type SigResult = { status: 'landed' | 'failed' | 'timeout'; slot?: number; err?: string };
const inflight = new Map<string, { until: number; resolve: (r: SigResult) => void }>();
let poller: NodeJS.Timeout | null = null;
export const inflightCount = () => inflight.size;

function trackSignature(conn: Connection, sig: string, timeoutMs: number): Promise<SigResult> {
  return new Promise((resolve) => {
    inflight.set(sig, { until: Date.now() + timeoutMs, resolve });
    if (!poller) poller = setInterval(() => void pollInflight(conn), 1500);
  });
}
async function pollInflight(conn: Connection): Promise<void> {
  if (!inflight.size) { if (poller) { clearInterval(poller); poller = null; } return; }
  const sigs = [...inflight.keys()].slice(0, 100);
  try {
    const { value } = await conn.getSignatureStatuses(sigs);
    sigs.forEach((sig, i) => {
      const s = value[i]; const e = inflight.get(sig); if (!e) return;
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
        inflight.delete(sig);
        e.resolve(s.err ? { status: 'failed', slot: s.slot, err: JSON.stringify(s.err) } : { status: 'landed', slot: s.slot });
      }
    });
  } catch (e) {
    console.warn('  status poll failed:', (e as Error).message.slice(0, 80));
  }
  const now = Date.now();
  for (const [sig, e] of inflight) if (now > e.until) { inflight.delete(sig); e.resolve({ status: 'timeout' }); }
}

// ---- Rent reclaim ---------------------------------------------------------------
// legA creates the token's associated account (0.00204 SOL rent, locked, not
// spent). After a landed round trip it sits empty; close it so the wallet
// balance is the truth. Any dust (positive slippage on legA) is burned first.
export async function reclaimEmptyTokenAccounts(
  conn: Connection,
  wallet: Keypair,
  onlyMint?: string,
): Promise<number> {
  let reclaimed = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accts = await conn.getTokenAccountsByOwner(wallet.publicKey, { programId }, 'confirmed');
    for (const { pubkey, account } of accts.value) {
      const info = unpackAccount(pubkey, account, programId);
      if (onlyMint && info.mint.toBase58() !== onlyMint) continue;
      const tx = new Transaction();
      if (info.amount > 0n) {
        // Dust worth < a fee: burn so the account can close. (Real balances are
        // never touched: anything above 0.0001 SOL-equivalent is left alone.)
        if (info.amount > 1_000_000n) continue; // suspiciously large — leave it
        tx.add(createBurnInstruction(pubkey, info.mint, wallet.publicKey, info.amount, [], programId));
      }
      tx.add(createCloseAccountInstruction(pubkey, wallet.publicKey, wallet.publicKey, [], programId));
      try {
        const sig = await conn.sendTransaction(tx, [wallet], { skipPreflight: false });
        await conn.confirmTransaction(sig, 'confirmed');
        reclaimed += account.lamports;
        console.log(`  reclaimed ${fmtSol(account.lamports)} SOL rent from ${info.mint.toBase58().slice(0, 6)}… (${sig.slice(0, 10)}…)`);
      } catch (e) {
        console.warn(`  reclaim failed for ${pubkey.toBase58().slice(0, 8)}…:`, (e as Error).message.slice(0, 120));
      }
    }
  }
  return reclaimed;
}

export { PublicKey };
