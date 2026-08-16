// Automatic token discovery, ranked by FEE WALL.
//
// Measured base rates (10k samples): a tradeable edge exists 1.5% of the time on
// ANSEM, 1.3% on TOAD, and 0.0% on JUP/BONK/WIF/MET. Opportunity lives in the
// long tail, and the long tail rotates — so the watch list has to rotate too.
//
// Ranking is by fee wall (sum of the two cheapest venue fees for a round trip),
// because that is what decides whether a spread is capturable at all, not
// liquidity or volume. Fees are read from the pools on-chain, never guessed.
import { Connection } from '@solana/web3.js';
import { CFG } from './config.js';
import { discoverPools, initModel, initPool, type Pool } from './pools.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0', Accept: 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Candidate { symbol: string; mint: string; wall: number; pools: number; liqUsd: number; volUsd: number }

async function jupList(ep: string): Promise<Array<Record<string, any>>> {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/${ep}`, { headers: UA });
    return r.ok ? ((await r.json()) as Array<Record<string, any>>) : [];
  } catch { return []; }
}

// Screen the current market and return tokens sorted by fee wall (cheapest first).
export async function screenTokens(conn: Connection, exclude: Set<string>, maxToInspect = 24): Promise<Candidate[]> {
  const seen = new Map<string, { symbol: string; mint: string; liq: number; vol: number }>();
  for (const ep of ['toptraded/24h', 'toporganicscore/24h', 'toptrending/24h']) {
    for (const t of await jupList(ep)) {
      const a = t.audit ?? {};
      const s24 = t.stats24h ?? {};
      const vol = (s24.buyVolume ?? 0) + (s24.sellVolume ?? 0);
      if (exclude.has(t.id)) continue;
      if ((t.liquidity ?? 0) < CFG.discoverMinLiqUsd || vol < CFG.discoverMinVolUsd) continue;
      if (!a.mintAuthorityDisabled || !a.freezeAuthorityDisabled) continue;
      seen.set(t.id, { symbol: String(t.symbol ?? '?'), mint: t.id, liq: t.liquidity, vol });
    }
    await sleep(1200);
  }
  const out: Candidate[] = [];
  for (const c of [...seen.values()].slice(0, maxToInspect)) {
    try {
      const pools = await discoverPools(c.symbol, c.mint, 40_000, 6);
      if (pools.length < 2) continue;
      const infos = await conn.getMultipleAccountsInfo(pools.map((p) => p.address));
      const fees: number[] = [];
      for (let i = 0; i < pools.length; i++) {
        const p: Pool = pools[i], info = infos[i];
        if (!info) continue;
        p.decimals = 9;
        if (!(await initPool(conn, p, info.data))) continue;
        const m = await initModel(conn, p, info.data);
        if (m) fees.push(m.fee * 1e4);
      }
      if (fees.length < 2) continue;
      fees.sort((a, b) => a - b);
      out.push({ symbol: c.symbol, mint: c.mint, wall: fees[0] + fees[1], pools: fees.length, liqUsd: c.liq, volUsd: c.vol });
      await sleep(500);
    } catch { /* skip this candidate */ }
  }
  return out.filter((c) => c.wall <= CFG.discoverMaxWallBps).sort((a, b) => a.wall - b.wall);
}
