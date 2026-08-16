import { quote, type Quote } from './jupiter.js';
import { SOL, TOKENS } from './tokens.js';
import { CFG } from './config.js';

export interface Opportunity {
  symbol: string;
  mint: string;
  inLamports: bigint;
  outLamports: bigint;     // expected SOL back (quoted)
  minOutLamports: bigint;  // worst-case SOL back (on-chain min after slippage)
  edgeBps: number;         // expected edge
  legA: Quote | null;      // null => built locally from localBuy
  legB: Quote | null;      // null => built locally from localSell
  localBuy?: import('./pools.js').Pool;
  localSell?: import('./pools.js').Pool;
  tokAmount?: bigint;      // tokens legA delivers (exact for a local buy)
}

// Round trip: SOL -> token -> SOL. If out > in after both legs' routing
// (which already spans multiple pools), an atomic edge exists on paper.
//
// `onCandidate` fires the moment a pair clears MIN_PROFIT_BPS — while its
// quotes are ~1s old — instead of after the whole scan (which on the free
// Jupiter tier can be 20s+, by which time the edge is gone).
// ---- Adaptive scheduling ----------------------------------------------------
// The request budget is fixed; spend it where an edge can appear. A pair's
// last observed edge decides how often it's re-quoted:
//   >= HOT_BPS   every cycle      (close to firing — watch it)
//   >= COLD_BPS  every 3rd cycle  (warm)
//   <  COLD_BPS  every 8th cycle  (dead weight, but check for recovery)
// Unknown pairs are hot until first quoted.
const lastEdge = new Map<string, number>();
let cycle = 0;
export function dueThisCycle(symbol: string): boolean {
  const e = lastEdge.get(symbol);
  if (e === undefined || e >= CFG.hotBps) return true;
  if (e >= CFG.coldBps) return cycle % 3 === 0;
  return cycle % 8 === 0;
}
export const tierOf = (symbol: string) => {
  const e = lastEdge.get(symbol);
  return e === undefined || e >= CFG.hotBps ? 'hot' : e >= CFG.coldBps ? 'warm' : 'cold';
};
export const tierCounts = () => {
  const c = { hot: 0, warm: 0, cold: 0 };
  for (const s of Object.keys(TOKENS)) c[tierOf(s)]++;
  return `${c.hot}h/${c.warm}w/${c.cold}c`;
};

export async function scanOnce(
  onCandidate?: (opp: Opportunity) => Promise<void>,
  include?: (symbol: string) => boolean,
): Promise<Opportunity[]> {
  const inLamports = BigInt(Math.floor(CFG.tradeSizeSol * 1e9));
  const found: Opportunity[] = [];
  cycle++;

  for (const [symbol, mint] of Object.entries(TOKENS)) {
    if (include && !include(symbol)) continue;
    if (!dueThisCycle(symbol)) continue;
    try {
      const legA = await quote(SOL, mint, inLamports);
      if (!legA) continue;
      // legB sells what legA GUARANTEES (its on-chain minimum), not what it
      // expects — otherwise a fill even 1 unit short of the forecast leaves legB
      // trying to transfer tokens we do not hold and the bundle dies for nothing.
      const legB = await quote(mint, SOL, BigInt(legA.otherAmountThreshold));
      if (!legB) continue;
      const out = BigInt(legB.outAmount);
      const minOut = BigInt(legB.otherAmountThreshold);
      const edgeBps = Number(((out - inLamports) * 10_000n) / inLamports);
      const opp: Opportunity = {
        symbol, mint, inLamports, outLamports: out, minOutLamports: minOut, edgeBps, legA, legB,
      };
      found.push(opp);
      lastEdge.set(symbol, edgeBps);
      if (onCandidate && edgeBps >= CFG.minProfitBps) await onCandidate(opp);
    } catch (e) {
      console.warn(`  scan ${symbol}:`, (e as Error).message);
    }
  }
  return found.sort((a, b) => b.edgeBps - a.edgeBps);
}
