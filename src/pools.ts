// On-chain pool discovery + price decoders.
//
// This is the "stop asking Jupiter" layer: we read the DEX pool accounts
// directly and compute each pool's mid price locally. Layouts are hard-coded
// per DEX; every pool is VALIDATED at startup against a reference price and
// disabled if the decode disagrees, so a wrong offset can't fire a trade.
import { Connection, PublicKey } from '@solana/web3.js';
import { SOL } from './tokens.js';

export type Dex = 'pumpswap' | 'raydium-v4' | 'raydium-clmm' | 'orca-wp' | 'meteora-dlmm';

export interface Pool {
  symbol: string;
  mint: string;
  dex: Dex;
  address: PublicKey;
  liqUsd: number;
  refPrice: number;             // SOL per token, from discovery (last trade)
  // accounts whose changes move the price (pool itself, or vaults for CP AMMs)
  watch: PublicKey[];
  // decode(state) -> SOL per token (UI units), or null if not decodable
  price: number | null;
  ok: boolean;                  // passed validation
  decimals: number;
  token2022: boolean;           // mint is owned by the Token-2022 program

  // constant-product state (vaults)
  baseVault?: PublicKey; quoteVault?: PublicKey; baseIsToken?: boolean;
  baseReserve?: bigint; quoteReserve?: bigint;
  // note for logs
  note?: string;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0', Accept: 'application/json' };

// ---- Discovery (DexScreener, free; only used at startup) ---------------------
export async function discoverPools(symbol: string, mint: string, minLiqUsd = 15_000, max = 5): Promise<Pool[]> {
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, { headers: UA });
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const d = (await r.json()) as Array<{
    dexId: string; labels?: string[]; pairAddress: string; priceNative: string;
    quoteToken: { address: string }; liquidity?: { usd: number };
  }>;
  const out: Pool[] = [];
  for (const p of d) {
    if (p.quoteToken?.address !== SOL) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (liq < minLiqUsd) continue;
    const label = (p.labels ?? []).join(',');
    let dex: Dex | null = null;
    if (p.dexId === 'pumpswap') dex = 'pumpswap';
    else if (p.dexId === 'raydium' && label === '') dex = 'raydium-v4';
    else if (p.dexId === 'raydium' && label === 'CLMM') dex = 'raydium-clmm';
    else if (p.dexId === 'orca' && label === 'wp') dex = 'orca-wp';
    else if (p.dexId === 'meteora' && label === 'DLMM') dex = 'meteora-dlmm';
    if (!dex) continue; // DYN, CPMM, etc: not decoded (yet)
    out.push({
      symbol, mint, dex, address: new PublicKey(p.pairAddress), liqUsd: liq,
      refPrice: Number(p.priceNative), watch: [], price: null, ok: false, decimals: 0, token2022: false,
    });
  }
  return out.sort((a, b) => b.liqUsd - a.liqUsd).slice(0, max);
}

// ---- Decoders --------------------------------------------------------------------
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => (b.readBigUInt64LE(o + 8) << 64n) | b.readBigUInt64LE(o);
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const TWO64 = 2 ** 64;

// sqrt-price (Q64.64) pools: price(B per A) = (sqrtP/2^64)^2 * 10^(decA-decB)
function priceFromSqrt(sqrtX64: bigint, decA: number, decB: number): number {
  const s = Number(sqrtX64) / TWO64;
  return s * s * 10 ** (decA - decB);
}

// Initialise a pool: figure out which accounts to watch and how to price it.
// `state` is the pool account data. Returns false if the layout doesn't fit.
export async function initPool(conn: Connection, p: Pool, state: Buffer): Promise<boolean> {
  const solPk = new PublicKey(SOL);
  const tokenPk = new PublicKey(p.mint);
  try {
    switch (p.dex) {
      case 'pumpswap': {
        // Pool { bump u8, index u16, creator, base_mint, quote_mint, lp_mint,
        //        pool_base_token_account, pool_quote_token_account, lp_supply u64, coin_creator }
        const baseMint = pk(state, 43), quoteMint = pk(state, 75);
        p.baseVault = pk(state, 139); p.quoteVault = pk(state, 171);
        if (baseMint.equals(tokenPk) && quoteMint.equals(solPk)) p.baseIsToken = true;
        else if (baseMint.equals(solPk) && quoteMint.equals(tokenPk)) p.baseIsToken = false;
        else return false;
        p.watch = [p.baseVault, p.quoteVault];
        return true;
      }
      case 'raydium-v4': {
        // AmmInfo: baseVault@336 quoteVault@368 baseMint@400 quoteMint@432
        if (state.length < 752) return false;
        const baseMint = pk(state, 400), quoteMint = pk(state, 432);
        p.baseVault = pk(state, 336); p.quoteVault = pk(state, 368);
        if (baseMint.equals(tokenPk) && quoteMint.equals(solPk)) p.baseIsToken = true;
        else if (baseMint.equals(solPk) && quoteMint.equals(tokenPk)) p.baseIsToken = false;
        else return false;
        p.watch = [p.baseVault, p.quoteVault];
        return true;
      }
      case 'raydium-clmm': {
        // PoolState: bump@8 amm_config@9 owner@41 mint0@73 mint1@105 vault0@137 vault1@169
        //            observation@201 decimals0@233 decimals1@234 tick_spacing@235 liquidity@237 sqrt_price_x64@253
        const m0 = pk(state, 73), m1 = pk(state, 105);
        if (!((m0.equals(tokenPk) && m1.equals(solPk)) || (m0.equals(solPk) && m1.equals(tokenPk)))) return false;
        p.watch = [p.address];
        p.price = decodePrice(p, state);
        return p.price !== null;
      }
      case 'orca-wp': {
        // Whirlpool: sqrtPrice@65 (u128) tokenMintA@101 tokenVaultA@133 tokenMintB@181
        const a = pk(state, 101), b = pk(state, 181);
        if (!((a.equals(tokenPk) && b.equals(solPk)) || (a.equals(solPk) && b.equals(tokenPk)))) return false;
        p.watch = [p.address];
        p.price = decodePrice(p, state);
        return p.price !== null;
      }
      case 'meteora-dlmm': {
        // LbPair: active_id i32@76 bin_step u16@80 token_x_mint@88 token_y_mint@120
        const x = pk(state, 88), y = pk(state, 120);
        if (!((x.equals(tokenPk) && y.equals(solPk)) || (x.equals(solPk) && y.equals(tokenPk)))) return false;
        p.watch = [p.address];
        p.price = decodePrice(p, state);
        return p.price !== null;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// Price (SOL per token, UI units) from the pool account state (non-CP pools).
export function decodePrice(p: Pool, state: Buffer): number | null {
  const solPk = new PublicKey(SOL);
  try {
    if (p.dex === 'orca-wp') {
      const a = pk(state, 101);
      const aIsToken = !a.equals(solPk);
      const sqrt = u128(state, 65);
      const decA = aIsToken ? p.decimals : 9, decB = aIsToken ? 9 : p.decimals;
      const priceBperA = priceFromSqrt(sqrt, decA, decB);
      return aIsToken ? priceBperA : 1 / priceBperA;
    }
    if (p.dex === 'raydium-clmm') {
      const m0 = pk(state, 73);
      const zeroIsToken = !m0.equals(solPk);
      const sqrt = u128(state, 253);
      const dec0 = state[233], dec1 = state[234];
      const price1per0 = priceFromSqrt(sqrt, dec0, dec1);
      return zeroIsToken ? price1per0 : 1 / price1per0;
    }
    if (p.dex === 'meteora-dlmm') {
      const x = pk(state, 88);
      const xIsToken = !x.equals(solPk);
      const activeId = state.readInt32LE(76);
      const binStep = state.readUInt16LE(80);
      const decX = xIsToken ? p.decimals : 9, decY = xIsToken ? 9 : p.decimals;
      const priceYperX = (1 + binStep / 10_000) ** activeId * 10 ** (decX - decY);
      return xIsToken ? priceYperX : 1 / priceYperX;
    }
  } catch {
    return null;
  }
  return null;
}

// Constant-product pools: price from vault reserves.
export function cpPrice(p: Pool): number | null {
  if (p.baseReserve === undefined || p.quoteReserve === undefined) return null;
  const tokRes = p.baseIsToken ? p.baseReserve : p.quoteReserve;
  const solRes = p.baseIsToken ? p.quoteReserve : p.baseReserve;
  if (tokRes === 0n) return null;
  return (Number(solRes) / 1e9) / (Number(tokRes) / 10 ** p.decimals);
}

export const isCp = (p: Pool) => p.dex === 'pumpswap' || p.dex === 'raydium-v4';

// SPL token account: amount u64 @64
export const tokenAmount = (data: Buffer) => u64(data, 64);

// =============================================================================
// Executable-price engine: exact-in swap output per pool, locally.
// =============================================================================
// Numbers are floats over RAW units (lamports / token base units); bps-level
// precision is all we need to decide, and Jupiter builds the actual tx.

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const BINS_PER_ARRAY = 70;
const BIN_SIZE = 144;
const BIN_ARRAY_HEADER = 56;

export interface PoolModel {
  // fee as fraction of input (0.0025 = 25 bps). DLMM: base only; variable added live.
  fee: number;
  // constant-product: reserves are already on Pool (baseReserve/quoteReserve)
  // concentrated liquidity
  liquidity?: number; sqrtP?: number; tickCurrent?: number; tickSpacing?: number; aIsToken?: boolean;
  // dlmm
  dlmm?: {
    xIsToken: boolean; binStep: number; activeId: number;
    baseFactor: number; bfpf: number; variableFeeControl: number; maxVolAcc: number;
    filterPeriod: number; decayPeriod: number; reductionFactor: number;
    volAcc: number; volRef: number; indexRef: number; lastUpdate: number;
    arrays: Map<number, { at: number; bins: { x: number; y: number }[] }>;
  };
  // learned correction: jupiter_out / local_out (EMA), starts at 1
  calib: number;
  calibN: number;
}

export const models = new WeakMap<Pool, PoolModel>();

const i32 = (b: Buffer, o: number) => b.readInt32LE(o);
const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

// Called once after initPool() with the pool account data.
export async function initModel(conn: Connection, p: Pool, state: Buffer): Promise<PoolModel | null> {
  const solPk = new PublicKey(SOL);
  let m: PoolModel | null = null;
  try {
    switch (p.dex) {
      case 'pumpswap':
        // lp 0.20% + protocol 0.05% + creator 0.05% (tiers vary by mcap; calib absorbs it)
        m = { fee: 0.0030, calib: 1, calibN: 0 };
        break;
      case 'raydium-v4': {
        const num = Number(u64(state, 176)), den = Number(u64(state, 184));
        m = { fee: den > 0 ? num / den : 0.0025, calib: 1, calibN: 0 };
        break;
      }
      case 'orca-wp': {
        m = { fee: u16(state, 45) / 1e6, calib: 1, calibN: 0 };
        m.aIsToken = !pk(state, 101).equals(solPk);
        updateCl(p, m, state);
        break;
      }
      case 'raydium-clmm': {
        // trade_fee_rate lives in AmmConfig (address @9): u32 @47, /1e6
        const cfg = await conn.getAccountInfo(pk(state, 9));
        const feeRate = cfg ? u32(cfg.data, 47) / 1e6 : 0.0025;
        m = { fee: feeRate, calib: 1, calibN: 0 };
        m.aIsToken = !pk(state, 73).equals(solPk);
        updateCl(p, m, state);
        break;
      }
      case 'meteora-dlmm': {
        const binStep = u16(state, 80);
        const baseFactor = u16(state, 8), bfpf = state[34];
        const baseFee = (binStep * baseFactor * 10 * 10 ** bfpf) / 1e9;
        m = {
          fee: baseFee, calib: 1, calibN: 0,
          dlmm: {
            xIsToken: !pk(state, 88).equals(solPk), binStep, activeId: i32(state, 76),
            baseFactor, bfpf, variableFeeControl: u32(state, 16), maxVolAcc: u32(state, 20),
            filterPeriod: u16(state, 10), decayPeriod: u16(state, 12), reductionFactor: u16(state, 14),
            volAcc: u32(state, 40), volRef: u32(state, 44), indexRef: i32(state, 48), lastUpdate: Number(state.readBigInt64LE(56)),
            arrays: new Map(),
          },
        };
        break;
      }
    }
  } catch {
    return null;
  }
  if (m) models.set(p, m);
  return m;
}

// Refresh model state from a new pool account update (non-CP pools).
export function updateModel(p: Pool, state: Buffer): void {
  const m = models.get(p);
  if (!m) return;
  if (p.dex === 'orca-wp' || p.dex === 'raydium-clmm') updateCl(p, m, state);
  if (m.dlmm) {
    m.dlmm.activeId = i32(state, 76);
    m.dlmm.volAcc = u32(state, 40); m.dlmm.volRef = u32(state, 44);
    m.dlmm.indexRef = i32(state, 48); m.dlmm.lastUpdate = Number(state.readBigInt64LE(56));
  }
}

function updateCl(p: Pool, m: PoolModel, state: Buffer): void {
  if (p.dex === 'orca-wp') {
    m.liquidity = Number(u128(state, 49)); m.sqrtP = Number(u128(state, 65)) / TWO64;
    m.tickCurrent = i32(state, 81); m.tickSpacing = u16(state, 41);
  } else {
    m.liquidity = Number(u128(state, 237)); m.sqrtP = Number(u128(state, 253)) / TWO64;
    m.tickCurrent = i32(state, 269); m.tickSpacing = u16(state, 235);
  }
}

// ---- DLMM bin arrays (fetched on demand, cached briefly) ----------------------
function binArrayIndex(binId: number): number { return Math.floor(binId / BINS_PER_ARRAY); }
function binArrayPda(lbPair: PublicKey, index: number): PublicKey {
  const idx = Buffer.alloc(8); idx.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from('bin_array'), lbPair.toBuffer(), idx], DLMM_PROGRAM)[0];
}
export async function ensureBinArrays(conn: Connection, p: Pool, maxAgeMs = 1500): Promise<boolean> {
  const m = models.get(p);
  if (!m?.dlmm) return false;
  const c = binArrayIndex(m.dlmm.activeId);
  const want = [c - 1, c, c + 1].filter((i) => { const a = m.dlmm!.arrays.get(i); return !a || Date.now() - a.at > maxAgeMs; });
  if (!want.length) return true;
  const infos = await conn.getMultipleAccountsInfo(want.map((i) => binArrayPda(p.address, i)), 'processed');
  want.forEach((i, k) => {
    const info = infos[k];
    const bins: { x: number; y: number }[] = [];
    if (info && info.data.length >= BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE) {
      for (let b = 0; b < BINS_PER_ARRAY; b++) {
        const o = BIN_ARRAY_HEADER + b * BIN_SIZE;
        bins.push({ x: Number(u64(info.data, o)), y: Number(u64(info.data, o + 8)) });
      }
    } // missing array = no liquidity there (bins stay empty)
    m.dlmm!.arrays.set(i, { at: Date.now(), bins });
  });
  return true;
}
function binOf(m: PoolModel, id: number): { x: number; y: number } | null {
  const arr = m.dlmm!.arrays.get(binArrayIndex(id));
  if (!arr) return null; // not loaded
  return arr.bins[id - binArrayIndex(id) * BINS_PER_ARRAY] ?? { x: 0, y: 0 };
}

// ---- Exact-in swap -----------------------------------------------------------------
// Returns raw output amount for `amountIn` raw units of `inMint`, or null if the
// pool can't be priced locally right now (crossing a tick / bin data missing).
export function swapOut(p: Pool, inMint: string, amountIn: number): number | null {
  const m = models.get(p);
  if (!m || !p.ok || amountIn <= 0) return null;
  const inIsSol = inMint === SOL;
  let out: number | null = null;

  if (isCp(p)) {
    if (p.baseReserve === undefined || p.quoteReserve === undefined) return null;
    const rBase = Number(p.baseReserve), rQuote = Number(p.quoteReserve);
    const inIsBase = p.baseIsToken ? !inIsSol : inIsSol;
    const rIn = inIsBase ? rBase : rQuote, rOut = inIsBase ? rQuote : rBase;
    const net = amountIn * (1 - m.fee);
    out = (net * rOut) / (rIn + net);
  } else if (m.dlmm) {
    out = dlmmSwapOut(m, inIsSol, amountIn);
  } else if (m.sqrtP !== undefined && m.liquidity !== undefined) {
    // Concentrated liquidity, within the current tick-spacing range only.
    const L = m.liquidity, s = m.sqrtP;
    if (L <= 0) return null;
    const inIsA = m.aIsToken ? !inIsSol : inIsSol;
    const net = amountIn * (1 - m.fee);
    let s2: number;
    if (inIsA) { s2 = (L * s) / (L + net * s); out = L * (s - s2); }
    else       { s2 = s + net / L;              out = L * (1 / s - 1 / s2); }
    const lower = Math.floor(m.tickCurrent! / m.tickSpacing!) * m.tickSpacing!;
    const sLo = Math.pow(1.0001, lower / 2), sHi = Math.pow(1.0001, (lower + m.tickSpacing!) / 2);
    if (s2 < sLo || s2 > sHi) return null; // would cross a tick: liquidity changes, we don't model it
  }
  if (out === null || !Number.isFinite(out) || out < 0) return null;
  return out * m.calib;
}

function dlmmSwapOut(m: PoolModel, inIsSol: boolean, amountIn: number): number | null {
  const d = m.dlmm!;
  // Y-in (buying X) walks bins upward; X-in walks downward.
  const yIn = d.xIsToken ? inIsSol : !inIsSol;
  const now = Math.floor(Date.now() / 1000);
  // update_references (as the program would at swap start)
  const elapsed = now - d.lastUpdate;
  let indexRef = d.indexRef, volRef = d.volRef;
  if (elapsed >= d.filterPeriod) {
    indexRef = d.activeId;
    volRef = elapsed >= d.decayPeriod ? 0 : Math.floor((d.volAcc * d.reductionFactor) / 10_000);
  }
  const baseFee = d.binStep * d.baseFactor * 10 * 10 ** d.bfpf; // 1e9 precision
  let left = amountIn, out = 0, id = d.activeId;
  for (let steps = 0; steps < 140 && left > 0; steps++) {
    const bin = binOf(m, id);
    if (bin === null) return null; // array not loaded
    // fee for this bin
    const volAcc = Math.min(volRef + Math.abs(indexRef - id) * 10_000, d.maxVolAcc);
    const varFee = d.variableFeeControl > 0 ? Math.ceil((d.variableFeeControl * (volAcc * d.binStep) ** 2) / 1e11) : 0;
    const rate = Math.min(baseFee + varFee, 1e8) / 1e9;
    const price = Math.pow(1 + d.binStep / 10_000, id); // Y per X, raw units
    const avail = yIn ? bin.x : bin.y;
    if (avail > 0) {
      const maxOut = avail;
      const maxInNet = yIn ? maxOut * price : maxOut / price; // net input to drain this bin
      const maxInGross = maxInNet / (1 - rate);
      if (left <= maxInGross) {
        const net = left * (1 - rate);
        out += yIn ? net / price : net * price;
        left = 0;
      } else {
        out += maxOut;
        left -= maxInGross;
      }
    }
    if (left > 0) id += yIn ? 1 : -1;
  }
  if (left > 0) return null; // ran out of loaded bins
  return out;
}

// Learn from a Jupiter route hop that went through this pool.
//  - constant-product pools: solve the IMPLIED FEE from reserves + Jupiter's out
//    (PumpSwap fees are tiered per pool — 48..105 bps observed — not the 30 bps
//    in the global config). Deterministic, so it converges on the first sample.
//  - everything else: multiplicative correction (models measured exact; ~1.0).
export function calibrate(p: Pool, inMint: string, inAmount: number, jupOut: number): string | null {
  const m = models.get(p);
  if (!m) return null;
  if (isCp(p)) {
    if (p.baseReserve === undefined || p.quoteReserve === undefined) return null;
    const inIsSol = inMint === SOL;
    const inIsBase = p.baseIsToken ? !inIsSol : inIsSol;
    const rIn = Number(inIsBase ? p.baseReserve : p.quoteReserve), rOut = Number(inIsBase ? p.quoteReserve : p.baseReserve);
    if (jupOut >= rOut) return null;
    const net = (jupOut * rIn) / (rOut - jupOut);
    const fee = 1 - net / inAmount;
    if (!(fee > 0 && fee < 0.05)) return null;
    m.calibN++;
    m.fee = m.calibN === 1 ? fee : 0.5 * m.fee + 0.5 * fee;
    return `${p.dex} fee→${(m.fee * 1e4).toFixed(1)}bps`;
  }
  const local = swapOut(p, inMint, inAmount);
  if (!local || local <= 0) return null;
  const ratio = (jupOut / local) * m.calib;
  m.calibN++;
  m.calib = m.calibN === 1 ? ratio : 0.7 * m.calib + 0.3 * ratio;
  return `${p.dex} ×${ratio.toFixed(4)}`;
}
export const modelOf = (p: Pool) => models.get(p);
