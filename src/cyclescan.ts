// Long-tail multi-hop cycle scanner. Builds the pool graph among our tokens —
// INCLUDING token-token pairs Jupiter's SOL-anchored router under-explores — and
// prices every 2/3/4-hop cycle locally with our exact swap math. A positive cycle
// after fees is a real flash-loan-able edge; if none exist, multi-hop is a dead end.
import { Connection, PublicKey } from '@solana/web3.js';
import { CFG } from './config.js';
import { initModel, initPool, swapOut, type Pool } from './pools.js';
type GPool = Pool & { pairBase: string; pairQuote: string };
import { SOL, TOKENS } from './tokens.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0', Accept: 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// All SOL- AND token-token pools for a mint (DexScreener returns every pair).
async function allPools(conn: Connection, symbol: string, mint: string): Promise<GPool[]> {
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, { headers: UA });
  if (!r.ok) return [];
  const d = (await r.json()) as any[];
  const out: GPool[] = [];
  for (const p of d) {
    const liq = p.liquidity?.usd ?? 0;
    if (liq < 30_000) continue;
    const dex = p.dexId === 'pumpswap' ? 'pumpswap' : p.dexId === 'raydium' && !(p.labels ?? []).length ? 'raydium-v4'
      : p.dexId === 'raydium' && (p.labels ?? []).includes('CLMM') ? 'raydium-clmm'
      : p.dexId === 'orca' && (p.labels ?? []).includes('wp') ? 'orca-wp'
      : p.dexId === 'meteora' && (p.labels ?? []).includes('DLMM') ? 'meteora-dlmm' : null;
    if (!dex) continue;
    out.push({ symbol, mint, dex: dex as Pool['dex'], address: new PublicKey(p.pairAddress), liqUsd: liq,
      refPrice: Number(p.priceNative), watch: [], price: null, ok: false, decimals: 0, token2022: false,
      pairBase: p.baseToken.address, pairQuote: p.quoteToken.address } as GPool);
  }
  return out;
}

export async function scanCycles(conn: Connection): Promise<void> {
  console.log('building long-tail pool graph (SOL + token-token pairs)…');
  // Tokens that cross-pair (not just SOL) — where triangular cycles can exist:
  // stablecoins and liquid-staking tokens.
  const XPAIR: Record<string,string> = {
    USDC:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    mSOL:'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', jitoSOL:'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    bSOL:'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', JupSOL:'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', PYUSD:'2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  };
  const mints = new Set<string>([SOL, ...Object.values(TOKENS), ...Object.values(XPAIR)]);
  const pools: any[] = [];
  const universe = { ...TOKENS, ...XPAIR } as Record<string,string>;
  for (const [sym, mint] of Object.entries(universe)) {
    for (const p of await allPools(conn, sym, mint)) { pools.push(p); mints.add(p.pairBase); mints.add(p.pairQuote); }
    await sleep(300);
  }
  // dedupe pools by address
  const uniq = new Map<string, any>(); for (const p of pools) uniq.set(p.address.toBase58(), p);
  const P = [...uniq.values()];
  console.log(`  ${P.length} pools across ${mints.size} mints`);
  // load models + decimals for pricing
  const decCache = new Map<string, number>();
  const infos = await conn.getMultipleAccountsInfo(P.map((p) => p.address));
  let priceable = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], info = infos[i]; if (!info) continue;
    // decimals of the non-anchor token
    for (const m of [p.pairBase, p.pairQuote]) if (!decCache.has(m)) { try { decCache.set(m, (await conn.getTokenSupply(new PublicKey(m))).value.decimals); await sleep(120); } catch { decCache.set(m, 9); } }
    p.decimals = decCache.get(p.mint) ?? 9;
    try { if (await initPool(conn, p, info.data)) { if (await initModel(conn, p, info.data)) { p.ok = true; priceable++; } } } catch { /* skip */ }
  }
  console.log(`  ${priceable} pools priceable locally`);
  // graph: mint -> [pools]
  const g = new Map<string, any[]>();
  for (const p of P) if (p.ok) for (const m of [p.pairBase, p.pairQuote]) { (g.get(m) ?? g.set(m, []).get(m)!).push(p); }
  // enumerate cycles SOL -> ... -> SOL up to 4 hops, price with swapOut
  const START = SOL, SIZE = 0.05 * 1e9;
  const found: { path: string[]; edgeBps: number }[] = [];
  function hop(pool: any, inMint: string): { outMint: string; out: (amt: number) => number | null } | null {
    const other = pool.pairBase === inMint ? pool.pairQuote : pool.pairBase;
    if (other === undefined) return null;
    return { outMint: other, out: (amt: number) => swapOut(pool, inMint, amt) };
  }
  function walk(mint: string, amt: number, path: string[], pathPools: any[], depth: number) {
    if (depth > 0 && mint === START) {
      const edge = (amt / SIZE - 1) * 10_000;
      if (edge > -50) found.push({ path: [...path], edgeBps: edge });
      return;
    }
    if (depth >= 4) return;
    for (const pool of g.get(mint) ?? []) {
      if (pathPools.includes(pool)) continue;
      const h = hop(pool, mint); if (!h) continue;
      const out = h.out(amt); if (!out || out <= 0) continue;
      walk(h.outMint, out, [...path, `${pool.symbol || pool.dex}`], [...pathPools, pool], depth + 1);
    }
  }
  walk(START, SIZE, ['SOL'], [], 0);
  found.sort((a, b) => b.edgeBps - a.edgeBps);
  console.log(`\n  ${found.length} cycles returning to SOL (showing best 15; edge = net after pool fees, before tx fees/tip):`);
  for (const c of found.slice(0, 15)) console.log(`    ${c.edgeBps >= 0 ? '+' : ''}${c.edgeBps.toFixed(1)} bps  ${c.path.join(' → ')} → SOL`);
  const positive = found.filter((c) => c.edgeBps > 5);
  console.log(`\n  ${positive.length} cycles beat +5 bps (a real flash-loanable edge would need to clear ~tx fees+tip ≈ 4-10 bps)`);
}
