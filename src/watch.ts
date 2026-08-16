// Real-time on-chain arb detector with a LOCAL executable-price engine.
//
// Stage 1 (every account event, µs): mid-price spread across a token's pools.
// Stage 2 (when stage 1 ≥ WATCH_STAGE1_BPS, ≤ once per LOCAL_EVAL_MS per token):
//   exact-in round trip SOL -> token (pool A) -> SOL (pool B) for every ordered
//   pool pair, using each pool's own math (fees, reserves / tick liquidity /
//   DLMM bins + dynamic fee). No Jupiter call. Best pair = local edge.
// Fire (local edge ≥ LOCAL_TRIGGER_BPS): ask Jupiter for the executable round
//   trip once (2 requests) -> lamports gate -> bundle. The Jupiter route hops
//   are then used to CALIBRATE each pool's model (jupiter_out / local_out).
import { Connection, PublicKey } from '@solana/web3.js';
import { CFG } from './config.js';
import { SOL, TOKENS } from './tokens.js';
import {
  calibrate, cpPrice, decodePrice, discoverPools, ensureBinArrays, initModel, initPool, isCp,
  modelOf, swapOut, tokenAmount, updateModel, type Pool,
} from './pools.js';
import { refreshHot } from './build.js';
import { quote, type Quote } from './jupiter.js';

export interface TokenBook {
  symbol: string;
  mint: string;
  pools: Pool[];
  spreadBps: number;          // stage 1: mid-to-mid
  localEdgeBps: number;       // stage 2: best local exact round trip
  localBuy?: Pool; localSell?: Pool;
  localSizeLamports?: number;   // size the local optimiser picked
  lastEvalAt: number;
  lastSignalAt: number;
  updates: number;
  signals: number;
  subIds?: number[];
  // accuracy tracking: local vs jupiter edge on signals
  lastJupEdge?: number;
  // Our local engine only knows 5 DEX types and the handful of pools DexScreener
  // reported. Jupiter routes ~30 venues and multi-hop paths we never see, so our
  // edge is systematically PESSIMISTIC on some tokens (XST measured 86 bps low,
  // repeatedly). Track that bias so the trigger can compensate instead of
  // filtering out opportunities we simply cannot see locally.
  biasBps?: number;   // EMA of (jupiter edge - local edge)
  biasN?: number;
}

export const books = new Map<string, TokenBook>();
const fmtP = (x: number) => (x >= 0.001 ? x.toFixed(7) : x.toExponential(4));
const ts = () => new Date().toISOString().slice(11, 19);

async function mintInfo(conn: Connection, mint: string): Promise<{ decimals: number; token2022: boolean }> {
  const pk = new PublicKey(mint);
  const [supply, acct] = await Promise.all([conn.getTokenSupply(pk), conn.getAccountInfo(pk)]);
  return { decimals: supply.value.decimals, token2022: !!acct && acct.owner.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };
}

export type SignalResult = { edgeBps: number; legA?: Quote; legB?: Quote } | null;

// Bring one token under live watch: discover its pools, validate decoders,
// build local price models, subscribe. Safe to call at runtime — this is what
// hourly rotation uses to adopt a freshly-screened token without a restart.
export async function addToken(
  conn: Connection,
  symbol: string,
  mint: string,
  onSignal: (book: TokenBook) => Promise<SignalResult>,
): Promise<boolean> {
  if (books.has(symbol)) return false;
  const before = books.size;
  await watchOne(conn, symbol, mint, onSignal);
  return books.size > before;
}

export function dropToken(conn: Connection, symbol: string): boolean {
  const b = books.get(symbol);
  if (!b) return false;
  for (const id of b.subIds ?? []) conn.removeAccountChangeListener(id).catch(() => {});
  books.delete(symbol);
  return true;
}

export async function startWatcher(
  conn: Connection,
  onSignal: (book: TokenBook) => Promise<SignalResult>,
): Promise<void> {
  for (const [symbol, mint] of Object.entries(TOKENS)) await watchOne(conn, symbol, mint, onSignal);
  console.log(`watcher: ${books.size} tokens priced locally, ${[...books.values()].reduce((n, b) => n + b.pools.length, 0)} pools, ${[...books.values()].reduce((n, b) => n + (b.subIds?.length ?? 0), 0)} subscriptions`);
  await warmStartupCalibration(conn);
  ready = true;
}

async function watchOne(
  conn: Connection,
  symbol: string,
  mint: string,
  onSignal: (book: TokenBook) => Promise<SignalResult>,
): Promise<void> {
  let subs = 0, okPools = 0, badPools = 0;
  {
    let pools: Pool[];
    try { pools = await discoverPools(symbol, mint); }
    catch (e) { console.warn(`  watch ${symbol}: discovery failed (${(e as Error).message}) — poll-only`); return; }
    if (pools.length < 2) { console.log(`  watch ${symbol}: only ${pools.length} decodable SOL pool(s) — poll-only`); return; }

    const { decimals, token2022 } = await mintInfo(conn, mint);
    const infos = await conn.getMultipleAccountsInfo(pools.map((p) => p.address));
    const book: TokenBook = { symbol, mint, pools: [], spreadBps: -Infinity, localEdgeBps: -Infinity, lastEvalAt: 0, lastSignalAt: 0, updates: 0, signals: 0, subIds: [] };

    for (let i = 0; i < pools.length; i++) {
      const p = pools[i]; const info = infos[i];
      p.decimals = decimals; p.token2022 = token2022;
      if (!info) { badPools++; continue; }
      if (!(await initPool(conn, p, info.data))) { badPools++; console.log(`  watch ${symbol}: ${p.dex} ${p.address.toBase58().slice(0, 6)}… layout mismatch — disabled`); continue; }
      if (isCp(p)) {
        const [b, q] = await conn.getMultipleAccountsInfo([p.baseVault!, p.quoteVault!]);
        if (!b || !q) { badPools++; continue; }
        p.baseReserve = tokenAmount(b.data); p.quoteReserve = tokenAmount(q.data);
        p.price = cpPrice(p);
      }
      const dev = p.price && p.refPrice ? Math.abs(p.price / p.refPrice - 1) : 1;
      if (p.price === null || dev > (p.dex === 'meteora-dlmm' ? 0.06 : 0.03)) {
        badPools++;
        console.log(`  watch ${symbol}: ${p.dex} ${p.address.toBase58().slice(0, 6)}… decode ${p.price === null ? 'failed' : `off by ${(dev * 100).toFixed(1)}%`} — disabled`);
        continue;
      }
      const m = await initModel(conn, p, info.data);
      if (!m) { badPools++; console.log(`  watch ${symbol}: ${p.dex} model init failed — disabled`); continue; }
      p.ok = true; okPools++;
      book.pools.push(p);

      for (const acct of p.watch) {
        const sid = conn.onAccountChange(acct, (ai) => {
          if (isCp(p)) {
            const amt = tokenAmount(ai.data);
            if (acct.equals(p.baseVault!)) p.baseReserve = amt; else p.quoteReserve = amt;
            p.price = cpPrice(p);
          } else {
            p.price = decodePrice(p, ai.data);
            updateModel(p, ai.data);
            // Keep the cached build accounts in step (activeId / tickCurrent) so the
            // firing path never needs an RPC read of the pool.
            const m = modelOf(p);
            refreshHot(p.address, { activeId: m?.dlmm?.activeId, tickCurrent: m?.tickCurrent });
          }
          book.updates++;
          void evaluate(conn, book, onSignal);
        }, 'processed');
        book.subIds!.push(sid);
        subs++;
      }
    }
    if (book.pools.length >= 2) {
      books.set(symbol, book);
      await evaluate(conn, book, onSignal, true);
      console.log(
        `  watch ${symbol}: ${book.pools.length} pools [${book.pools.map((p) => `${p.dex}@${fmtP(p.price!)} fee ${(modelOf(p)!.fee * 1e4).toFixed(0)}bps`).join(' | ')}]` +
          ` mid spread ${book.spreadBps.toFixed(0)} bps, local round trip ${Number.isFinite(book.localEdgeBps) ? book.localEdgeBps.toFixed(0) : 'n/a'} bps`,
      );
    } else {
      console.log(`  watch ${symbol}: fewer than 2 validated pools — poll-only`);
    }
  }
  void okPools; void badPools; void subs;
}

// Startup calibration for constant-product pools whose fee we can't read
// on-chain (PumpSwap tiers): one Jupiter quote pinned to that DEX each.
async function warmStartupCalibration(conn: Connection): Promise<void> {
  const inL = BigInt(Math.floor(CFG.tradeSizeSol * 1e9));
  for (const b of books.values()) {
    for (const p of b.pools.filter((x) => x.dex === 'pumpswap')) {
      try {
        const q = await quote(SOL, b.mint, inL, { dexes: 'Pump.fun Amm', onlyDirectRoutes: 'true' });
        const hop = (q?.routePlan as Array<{ swapInfo: { ammKey: string; inputMint: string; inAmount: string; outAmount: string } }> | undefined)?.[0]?.swapInfo;
        if (hop && hop.ammKey === p.address.toBase58()) {
          const note = calibrate(p, hop.inputMint, Number(hop.inAmount), Number(hop.outAmount));
          if (note) console.log(`  calibrated ${b.symbol} ${note}`);
        }
      } catch { /* next signal will calibrate it */ }
    }
  }
}

// Signals were serialised by ONE global flag: while any token was being handled
// (~1s of quoting/building/sending) every other token's opportunity was dropped.
// Edges live about a second, so that silently discarded concurrent chances.
// Now it is per-token: two different tokens can dislocate and both get handled.
const handling = new Set<string>();
let ready = false; // stage-2 signals wait until startup calibration is done

async function evaluate(conn: Connection, book: TokenBook, onSignal: (b: TokenBook) => Promise<SignalResult>, quiet = false): Promise<void> {
  const live = book.pools.filter((p) => p.ok && p.price && p.price > 0);
  if (live.length < 2) return;
  // Stage 1
  let buy = live[0], sell = live[0];
  for (const p of live) { if (p.price! < buy.price!) buy = p; if (p.price! > sell.price!) sell = p; }
  book.spreadBps = (sell.price! / buy.price! - 1) * 10_000;
  const now = Date.now();
  if (!quiet && (!ready || book.spreadBps < CFG.watchStage1Bps)) return;
  if (!quiet && now - book.lastEvalAt < CFG.localEvalMs) return;
  book.lastEvalAt = now;

  // Stage 2: exact local round trip over ordered pool pairs.
  const { best, bestBuy, bestSell, sizeLamports } = await computeLocal(conn, book, live);
  book.localEdgeBps = best; book.localBuy = bestBuy; book.localSell = bestSell; book.localSizeLamports = sizeLamports;
  if (quiet || handling.has(book.symbol)) return;

  // Compensate for our known blind spots: if Jupiter has repeatedly found routes
  // N bps better than ours on this token, a local reading of (trigger - N) is
  // worth a Jupiter check. Bounded so a single odd sample can't open the floodgates.
  const bias = (book.biasN ?? 0) >= 2 ? Math.max(0, Math.min(CFG.maxBiasBps, book.biasBps ?? 0)) : 0;
  const effTrigger = CFG.localTriggerBps - bias;
  const fire = Number.isFinite(best) && best >= effTrigger;
  // Fallback: can't price locally but the mid spread is huge — still worth one look, rarely.
  const blind = !Number.isFinite(best) && book.spreadBps >= CFG.watchBlindBps && now - book.lastSignalAt > 30_000;
  if (!fire && !blind) return;
  if (now - book.lastSignalAt < CFG.watchCooldownMs) return;
  book.lastSignalAt = now; book.signals++; handling.add(book.symbol);
  console.log(
    fire
      ? `${ts()} ⚡ ${book.symbol.padEnd(6)} LOCAL ${best >= 0 ? '+' : ''}${best.toFixed(1)} bps @ ${((sizeLamports ?? 0) / 1e9).toFixed(4)} SOL (buy ${bestBuy!.dex} → sell ${bestSell!.dex}, spread ${book.spreadBps.toFixed(0)}${bias ? `, jup-bias +${bias.toFixed(0)}` : ''})`
      : `${ts()} ⚡ ${book.symbol.padEnd(6)} mid spread ${book.spreadBps.toFixed(0)} bps but not locally priceable — one Jupiter look`,
  );
  try {
    const r = await onSignal(book);
    if (r) {
      book.lastJupEdge = r.edgeBps;
      if (Number.isFinite(best)) {
        const gap = r.edgeBps - best;
        book.biasN = (book.biasN ?? 0) + 1;
        book.biasBps = book.biasN === 1 ? gap : 0.7 * (book.biasBps ?? 0) + 0.3 * gap;
      }
      const c = calibrateFromRoute(book, ...[r.legA, r.legB].filter((q): q is Quote => !!q));
      console.log(`    ${book.symbol}: jupiter ${r.edgeBps} bps vs local ${Number.isFinite(best) ? best.toFixed(1) : 'n/a'} bps${c ? ` | calibrated ${c}` : ''}`);
    }
  } catch (e) {
    console.warn('  signal handler failed:', (e as Error).message);
  } finally {
    handling.delete(book.symbol);
  }
}

export interface LocalRT { best: number; bestBuy?: Pool; bestSell?: Pool; tokOut?: number; solOut?: number; sizeLamports?: number }

// ---- Optimal trade sizing --------------------------------------------------
// A dislocation is only a few bins/ticks deep. Trading a fixed size either
// overshoots it (slippage eats the edge, the trade never clears the bar) or
// undershoots it (leaves profit). Profit(size) rises then falls, so ternary
// search finds the peak exactly — and it costs nothing, because the pricing is
// local. This turns "no trade" into "small profitable trade" on thin pools.
export function optimalSize(
  buy: Pool, sell: Pool, mint: string, maxLamports: number, minLamports = 2_000_000,
): { size: number; tok: number; out: number; gross: number } | null {
  const grossAt = (size: number): { tok: number; out: number; gross: number } | null => {
    const tok = swapOut(buy, SOL, size);
    if (!tok) return null;
    const out = swapOut(sell, mint, tok);
    if (!out) return null;
    return { tok, out, gross: out - size };
  };
  if (maxLamports < minLamports) return null;
  let lo = minLamports, hi = maxLamports;
  for (let i = 0; i < 40 && hi - lo > 1000; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const g1 = grossAt(m1)?.gross ?? -Infinity, g2 = grossAt(m2)?.gross ?? -Infinity;
    if (g1 < g2) lo = m1; else hi = m2;
  }
  // Compare the peak against both ends: on a monotonic curve the best is an edge.
  let best: { size: number; tok: number; out: number; gross: number } | null = null;
  for (const size of [Math.round((lo + hi) / 2), minLamports, maxLamports]) {
    const g = grossAt(size);
    if (g && (!best || g.gross > best.gross)) best = { size, ...g };
  }
  return best && best.gross > 0 ? best : null;
}
async function computeLocal(conn: Connection, book: TokenBook, live?: Pool[]): Promise<LocalRT> {
  live ??= book.pools.filter((p) => p.ok && p.price && p.price > 0);
  const maxL = Math.floor(CFG.tradeSizeSol * 1e9); // configured size is the CAP; we may trade less
  const dlmm = live.filter((p) => p.dex === 'meteora-dlmm');
  if (dlmm.length) await Promise.all(dlmm.map((p) => ensureBinArrays(conn, p).catch(() => false)));
  let best = -Infinity, bestBuy: Pool | undefined, bestSell: Pool | undefined;
  let tokOut: number | undefined, solOut: number | undefined, sizeLamports: number | undefined;
  for (const a of live) {
    if (!swapOut(a, SOL, maxL)) continue; // pool can't price at all right now
    for (const b of live) {
      if (b === a) continue;
      const o = optimalSize(a, b, book.mint, maxL, Math.min(CFG.minSizeLamports, maxL));
      if (!o) continue;
      const edge = (o.out / o.size - 1) * 10_000;
      if (edge > best) { best = edge; bestBuy = a; bestSell = b; tokOut = o.tok; solOut = o.out; sizeLamports = o.size; }
    }
  }
  if (best === -Infinity) {
    // Nothing profitable at any size: still report the fixed-size edge for the log.
    for (const a of live) {
      const tok = swapOut(a, SOL, maxL); if (!tok) continue;
      for (const b of live) {
        if (b === a) continue;
        const sol = swapOut(b, book.mint, tok); if (!sol) continue;
        const edge = (sol / maxL - 1) * 10_000;
        if (edge > best) { best = edge; bestBuy = a; bestSell = b; tokOut = tok; solOut = sol; sizeLamports = maxL; }
      }
    }
  }
  return { best, bestBuy, bestSell, tokOut, solOut, sizeLamports };
}

// Fresh local round trip for a token (used to sanity-check Jupiter-poll hits).
export async function localRoundTrip(conn: Connection, symbol: string): Promise<LocalRT | null> {
  const book = books.get(symbol);
  if (!book) return null;
  const r = await computeLocal(conn, book);
  book.localEdgeBps = r.best; book.localBuy = r.bestBuy; book.localSell = r.bestSell; book.localSizeLamports = r.sizeLamports;
  return r;
}

// Every Jupiter quote we do make teaches the local model: for each route hop
// through one of our pools, ratio = jupiter_out / local_out.
function calibrateFromRoute(book: TokenBook, ...quotes: Quote[]): string {
  const notes: string[] = [];
  const byKey = new Map(book.pools.map((p) => [p.address.toBase58(), p]));
  for (const q of quotes) {
    const plan = (q.routePlan ?? []) as Array<{ swapInfo: { ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; label?: string } }>;
    for (const hop of plan) {
      const p = byKey.get(hop.swapInfo.ammKey);
      if (!p) continue;
      const note = calibrate(p, hop.swapInfo.inputMint, Number(hop.swapInfo.inAmount), Number(hop.swapInfo.outAmount));
      if (note) notes.push(note);
    }
  }
  return notes.join(', ');
}

export function watchSummary(): string {
  const parts: string[] = [];
  for (const b of books.values()) {
    const loc = Number.isFinite(b.localEdgeBps) ? b.localEdgeBps.toFixed(0) : 'n/a';
    parts.push(`${b.symbol}:${loc}${b.lastJupEdge !== undefined ? `(j${b.lastJupEdge})` : ''}${(b.biasN ?? 0) >= 2 && (b.biasBps ?? 0) > 5 ? `[+${(b.biasBps ?? 0).toFixed(0)}]` : ''}`);
  }
  return parts.join(' ');
}
