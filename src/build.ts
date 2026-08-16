// Local transaction builders — no Jupiter in the build path.
//
// PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA), layouts taken from
// live mainnet transactions on 2026-08-15 (slot ~439526000) and every PDA
// re-derived and checked against them (see session notes). The two
// "fee-share" accounts are per-integrator; we pass the pair Jupiter passes.
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Pool } from './pools.js';

export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const PUMP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const PUMP_PROTOCOL_FEE_RECIPIENT = new PublicKey('JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU');
const PUMP_OPTIONAL_PLACEHOLDER = new PublicKey('CtH2ezVE1KBxAmPGAkbUarS7eMTCebpghfc1guMjaWVc'); // uninitialised optional slot, as passed on-chain
const PUMP_FEE_SHARE = new PublicKey('3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR');       // integrator fee-share acct (Jupiter's)
const DISC_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISC_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

const pda = (seeds: (Buffer | Uint8Array)[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export interface PumpPoolAccounts {
  pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey;
  baseTokenProgram: PublicKey; quoteTokenProgram: PublicKey; coinCreator: PublicKey;
}

// Read what we need from the pool account (Pool { bump, index u16, creator, base_mint@43,
// quote_mint@75, lp_mint@107, base_vault@139, quote_vault@171, lp_supply u64@203, coin_creator@211 }).
export async function loadPumpPool(conn: Connection, pool: PublicKey): Promise<PumpPoolAccounts> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(PUMP_AMM)) throw new Error('not a PumpSwap pool');
  const d = info.data;
  const baseMint = new PublicKey(d.subarray(43, 75)), quoteMint = new PublicKey(d.subarray(75, 107));
  const [bm, qm] = await conn.getMultipleAccountsInfo([baseMint, quoteMint]);
  return {
    pool, baseMint, quoteMint,
    baseVault: new PublicKey(d.subarray(139, 171)), quoteVault: new PublicKey(d.subarray(171, 203)),
    baseTokenProgram: bm?.owner ?? TOKEN_PROGRAM_ID, quoteTokenProgram: qm?.owner ?? TOKEN_PROGRAM_ID,
    coinCreator: new PublicKey(d.subarray(211, 243)),
  };
}

function commonAccounts(p: PumpPoolAccounts, user: PublicKey) {
  const userBase = getAssociatedTokenAddressSync(p.baseMint, user, false, p.baseTokenProgram);
  const userQuote = getAssociatedTokenAddressSync(p.quoteMint, user, false, p.quoteTokenProgram);
  const creatorVaultAuth = pda([Buffer.from('creator_vault'), p.coinCreator.toBuffer()], PUMP_AMM);
  return {
    userBase, userQuote,
    protocolFeeAta: getAssociatedTokenAddressSync(p.quoteMint, PUMP_PROTOCOL_FEE_RECIPIENT, true, p.quoteTokenProgram),
    eventAuthority: pda([Buffer.from('__event_authority')], PUMP_AMM),
    creatorVaultAta: getAssociatedTokenAddressSync(p.quoteMint, creatorVaultAuth, true, p.quoteTokenProgram),
    creatorVaultAuth,
    feeConfig: pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], PUMP_FEE_PROGRAM),
    globalVol: pda([Buffer.from('global_volume_accumulator')], PUMP_AMM),
    userVol: pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_AMM),
    feeShareAta: getAssociatedTokenAddressSync(p.quoteMint, PUMP_FEE_SHARE, true, p.quoteTokenProgram),
  };
}
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

// buy(base_amount_out, max_quote_amount_in, track_volume=true) — 26 accounts
// With a Jupiter template we use `buy_exact_quote_in(quote_in, min_base_out, track_volume)`
// (what Jupiter itself CPIs today) — exact SOL in, min tokens out. Args are then
// (minBaseOut, quoteIn) — the same numbers our callers already pass.
const DISC_BUY_EXACT_QUOTE_IN = Buffer.from('c62e1552b4d9e870', 'hex');
export function pumpBuyIx(p: PumpPoolAccounts, user: PublicKey, baseAmountOut: bigint, maxQuoteIn: bigint, template?: PumpTpl | null): TransactionInstruction {
  if (template) {
    return new TransactionInstruction({ programId: PUMP_AMM, keys: template.keys.map((k, i) => ({ pubkey: k, isSigner: i === 1, isWritable: template.writable[i] || i === 1 })), data: Buffer.concat([DISC_BUY_EXACT_QUOTE_IN, u64le(maxQuoteIn), u64le(baseAmountOut)]) });
  }
  const c = commonAccounts(p, user);
  return new TransactionInstruction({
    programId: PUMP_AMM,
    keys: [
      w(p.pool), w(user, true), r(PUMP_GLOBAL_CONFIG), r(p.baseMint), r(p.quoteMint), w(c.userBase), w(c.userQuote),
      w(p.baseVault), w(p.quoteVault), r(PUMP_PROTOCOL_FEE_RECIPIENT), w(c.protocolFeeAta), r(p.baseTokenProgram), r(p.quoteTokenProgram),
      r(SystemProgram.programId), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(c.eventAuthority), r(PUMP_AMM),
      w(c.creatorVaultAta), r(c.creatorVaultAuth), r(c.globalVol), w(c.userVol), r(c.feeConfig), r(PUMP_FEE_PROGRAM),
      r(PUMP_OPTIONAL_PLACEHOLDER), r(PUMP_FEE_SHARE), w(c.feeShareAta),
    ],
    data: Buffer.concat([DISC_BUY, u64le(baseAmountOut), u64le(maxQuoteIn), Buffer.from([1])]),
  });
}
// sell(base_amount_in, min_quote_amount_out) — 24 accounts
export function pumpSellIx(p: PumpPoolAccounts, user: PublicKey, baseAmountIn: bigint, minQuoteOut: bigint, template?: PumpTpl | null): TransactionInstruction {
  if (template) {
    return new TransactionInstruction({ programId: PUMP_AMM, keys: template.keys.map((k, i) => ({ pubkey: k, isSigner: i === 1, isWritable: template.writable[i] || i === 1 })), data: Buffer.concat([DISC_SELL, u64le(baseAmountIn), u64le(minQuoteOut)]) });
  }
  const c = commonAccounts(p, user);
  return new TransactionInstruction({
    programId: PUMP_AMM,
    keys: [
      w(p.pool), w(user, true), r(PUMP_GLOBAL_CONFIG), r(p.baseMint), r(p.quoteMint), w(c.userBase), w(c.userQuote),
      w(p.baseVault), w(p.quoteVault), r(PUMP_PROTOCOL_FEE_RECIPIENT), w(c.protocolFeeAta), r(p.baseTokenProgram), r(p.quoteTokenProgram),
      r(SystemProgram.programId), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(c.eventAuthority), r(PUMP_AMM),
      w(c.creatorVaultAta), r(c.creatorVaultAuth), r(c.feeConfig), r(PUMP_FEE_PROGRAM),
      r(PUMP_OPTIONAL_PLACEHOLDER), r(PUMP_FEE_SHARE), w(c.feeShareAta),
    ],
    data: Buffer.concat([DISC_SELL, u64le(baseAmountIn), u64le(minQuoteOut)]),
  });
}

// Whole leg as one v0 tx: ensure ATAs, wrap SOL if buying, swap, unwrap.
export async function buildPumpLegTx(
  conn: Connection, wallet: Keypair, p: PumpPoolAccounts, side: 'buy' | 'sell',
  amountIn: bigint,        // buy: SOL lamports to spend (max); sell: base tokens to sell
  minOutOrBaseOut: bigint, // buy: base tokens expected (already slippage-adjusted); sell: min SOL out
  blockhash: string,
  extraIxs: TransactionInstruction[] = [], // e.g. the Jito tip transfer on the last leg
): Promise<VersionedTransaction> {
  const user = wallet.publicKey;
  const c = commonAccounts(p, user);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(user, c.userBase, user, p.baseMint, p.baseTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(user, c.userQuote, user, p.quoteMint, p.quoteTokenProgram),
  ];
  if (side === 'buy') {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: c.userQuote, lamports: amountIn }));
    ixs.push(createSyncNativeInstruction(c.userQuote, p.quoteTokenProgram));
    const t = await pumpTemplate(conn, p, user, 'buy');
    if (!t) throw new Error('pump template unavailable');
    ixs.push(pumpBuyIx(p, user, minOutOrBaseOut, amountIn, t));
  } else {
    const t = await pumpTemplate(conn, p, user, 'sell');
    if (!t) throw new Error('pump template unavailable');
    ixs.push(pumpSellIx(p, user, amountIn, minOutOrBaseOut, t));
  }
  if (p.quoteMint.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(c.userQuote, user, user, [], p.quoteTokenProgram));
  ixs.push(...extraIxs);
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return tx;
}

export const isPumpPool = (p: Pool) => p.dex === 'pumpswap';
// Venues whose swap instruction we hand-encode. PumpSwap and Meteora DLMM read
// the mint's token program dynamically, so they handle Token-2022. The legacy
// Whirlpool/Raydium `swap` instructions take a single SPL-Token program and are
// only valid for classic mints — Token-2022 there needs swapV2, which we do not
// encode, so those legs are handed to Jupiter instead of built wrong.
const TOKEN_2022_CAPABLE = new Set(['pumpswap', 'meteora-dlmm']);
const LOCAL_DEXES = new Set(['pumpswap', 'raydium-v4', 'meteora-dlmm', 'orca-wp', 'raydium-clmm']);
export const isLocalDex = (dex: string, isToken2022 = false) =>
  LOCAL_DEXES.has(dex) && (!isToken2022 || TOKEN_2022_CAPABLE.has(dex));

// =============================================================================
// Raydium AMM v4 (675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8), 17-account
// "no order-book" swapBaseIn: the eight OpenBook slots are the pool address
// itself (as live txs do since OpenBook markets were deprecated).
// =============================================================================
export const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAY_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

export interface RayV4PoolAccounts { pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey }

export async function loadRayV4Pool(conn: Connection, pool: PublicKey): Promise<RayV4PoolAccounts> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(RAY_V4)) throw new Error('not a Raydium v4 pool');
  const d = info.data;
  return { pool, baseVault: new PublicKey(d.subarray(336, 368)), quoteVault: new PublicKey(d.subarray(368, 400)), baseMint: new PublicKey(d.subarray(400, 432)), quoteMint: new PublicKey(d.subarray(432, 464)) };
}

export function rayV4SwapBaseInIx(p: RayV4PoolAccounts, user: PublicKey, userSource: PublicKey, userDest: PublicKey, amountIn: bigint, minOut: bigint): TransactionInstruction {
  const ph = r(p.pool); // placeholder for deprecated OpenBook accounts
  return new TransactionInstruction({
    programId: RAY_V4,
    keys: [
      r(TOKEN_PROGRAM_ID), w(p.pool), r(RAY_V4_AUTHORITY), ph, w(p.baseVault), w(p.quoteVault),
      ph, ph, ph, ph, ph, ph, ph, ph,
      w(userSource), w(userDest), r(user, true),
    ],
    data: Buffer.concat([Buffer.from([9]), u64le(amountIn), u64le(minOut)]),
  });
}

// side 'buy' = SOL -> token (source = WSOL ATA), 'sell' = token -> SOL.
export async function buildRayV4LegTx(
  conn: Connection, wallet: Keypair, p: RayV4PoolAccounts, side: 'buy' | 'sell',
  amountIn: bigint, minOut: bigint, blockhash: string, extraIxs: TransactionInstruction[] = [],
): Promise<VersionedTransaction> {
  const user = wallet.publicKey;
  const tokenMint = p.baseMint.equals(NATIVE_MINT) ? p.quoteMint : p.baseMint;
  const userTok = getAssociatedTokenAddressSync(tokenMint, user, false, TOKEN_PROGRAM_ID);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(user, userTok, user, tokenMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
  ];
  if (side === 'buy') {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: amountIn }));
    ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));
    ixs.push(rayV4SwapBaseInIx(p, user, userWsol, userTok, amountIn, minOut));
  } else {
    ixs.push(rayV4SwapBaseInIx(p, user, userTok, userWsol, amountIn, minOut));
  }
  ixs.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  ixs.push(...extraIxs);
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return tx;
}

// =============================================================================
// Meteora DLMM (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo) — swap2:
//   [lb_pair, bitmap_ext|program, reserve_x, reserve_y, user_in, user_out,
//    mint_x, mint_y, oracle, host_fee_in|program, user, prog_x, prog_y, memo,
//    event_authority, program, ...bin_arrays]
//   data = disc + amount_in u64 + min_out u64 + remaining_accounts_info(vec len 0)
// Layout + PDAs verified against live txs on 2026-08-16.
// =============================================================================
export const DLMM_PROG = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const MEMO_PROG = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DISC_SWAP2 = Buffer.from('414b3f4ceb5b5b88', 'hex');

export interface DlmmPoolAccounts {
  pool: PublicKey; tokenX: PublicKey; tokenY: PublicKey; reserveX: PublicKey; reserveY: PublicKey;
  progX: PublicKey; progY: PublicKey; oracle: PublicKey; bitmapExt: PublicKey | null; activeId: number;
}
export async function loadDlmmPool(conn: Connection, pool: PublicKey): Promise<DlmmPoolAccounts> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(DLMM_PROG)) throw new Error('not a DLMM pool');
  const d = info.data;
  const tokenX = new PublicKey(d.subarray(88, 120)), tokenY = new PublicKey(d.subarray(120, 152));
  const bitmap = pda([Buffer.from('bitmap'), pool.toBuffer()], DLMM_PROG);
  const [mx, my, bm] = await conn.getMultipleAccountsInfo([tokenX, tokenY, bitmap]);
  return {
    pool, tokenX, tokenY, reserveX: new PublicKey(d.subarray(152, 184)), reserveY: new PublicKey(d.subarray(184, 216)),
    progX: mx?.owner ?? TOKEN_PROGRAM_ID, progY: my?.owner ?? TOKEN_PROGRAM_ID,
    oracle: pda([Buffer.from('oracle'), pool.toBuffer()], DLMM_PROG), bitmapExt: bm ? bitmap : null, activeId: d.readInt32LE(76),
  };
}
export function dlmmBinArrayPda(pool: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(index));
  return pda([Buffer.from('bin_array'), pool.toBuffer(), b], DLMM_PROG);
}
export function dlmmSwap2Ix(p: DlmmPoolAccounts, user: PublicKey, userIn: PublicKey, userOut: PublicKey, amountIn: bigint, minOut: bigint, binArrays: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: DLMM_PROG,
    keys: [
      // bin_array_bitmap_extension is declared `mut` by the program when it is a
      // real account; when the pool has none, the program id itself is passed as
      // an Option::None placeholder and must stay read-only (a program is never
      // writable). Getting this wrong costs the whole trade — it cost us a
      // +308 bps CATE fill on 2026-08-16 with ConstraintMut (error 2000).
      w(p.pool), p.bitmapExt ? w(p.bitmapExt) : r(DLMM_PROG), w(p.reserveX), w(p.reserveY), w(userIn), w(userOut), r(p.tokenX), r(p.tokenY),
      w(p.oracle), r(DLMM_PROG), r(user, true), r(p.progX), r(p.progY), r(MEMO_PROG),
      r(pda([Buffer.from('__event_authority')], DLMM_PROG)), r(DLMM_PROG),
      ...binArrays.map((k) => w(k)),
    ],
    data: Buffer.concat([DISC_SWAP2, u64le(amountIn), u64le(minOut), Buffer.alloc(4)]),
  });
}
// side 'buy' = SOL -> token; the swap walks bins upward if SOL is Y (downward if SOL is X).
export async function buildDlmmLegTx(
  conn: Connection, wallet: Keypair, p: DlmmPoolAccounts, side: 'buy' | 'sell',
  amountIn: bigint, minOut: bigint, blockhash: string, extraIxs: TransactionInstruction[] = [],
): Promise<VersionedTransaction> {
  const user = wallet.publicKey;
  const solIsY = p.tokenY.equals(NATIVE_MINT);
  const tokenMint = solIsY ? p.tokenX : p.tokenY, tokenProg = solIsY ? p.progX : p.progY;
  const userTok = getAssociatedTokenAddressSync(tokenMint, user, false, tokenProg);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);
  // bin arrays: active one plus the two in the direction the swap moves (skip ones that don't exist)
  const binArrays = await dlmmBinArraysFor(conn, p, side === 'buy');
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(user, userTok, user, tokenMint, tokenProg),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
  ];
  if (side === 'buy') {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: amountIn }));
    ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));
    ixs.push(dlmmSwap2Ix(p, user, userWsol, userTok, amountIn, minOut, binArrays));
  } else {
    ixs.push(dlmmSwap2Ix(p, user, userTok, userWsol, amountIn, minOut, binArrays));
  }
  ixs.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  ixs.push(...extraIxs);
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return tx;
}

// =============================================================================
// Single-transaction round trip: [ATAs, wrap SOL, buy swap, sell swap, unwrap, tip]
// Returns null if the composed tx would exceed the 1232-byte limit (caller
// then falls back to a 2-tx bundle).
// =============================================================================
export type LocalPoolAccts = { kind: 'pump'; p: PumpPoolAccounts } | { kind: 'ray'; p: RayV4PoolAccounts } | { kind: 'dlmm'; p: DlmmPoolAccounts } | { kind: 'wp'; p: WhirlpoolAccounts } | { kind: 'clmm'; p: ClmmAccounts };

// Pool *account addresses* (vaults, mints, programs) never change once a pool
// exists, so they are cached forever. The only mutable fields we build with are
// DLMM activeId / CL tickCurrent, which the watcher already streams — those are
// refreshed from the live model in `refreshHot()` below, not over RPC.
const poolCache = new Map<string, LocalPoolAccts>();
export async function loadLocalPool(conn: Connection, dex: string, address: PublicKey): Promise<LocalPoolAccts> {
  const key = address.toBase58();
  const hit = poolCache.get(key);
  if (hit) return hit;
  const loaded: LocalPoolAccts =
    dex === 'pumpswap' ? { kind: 'pump', p: await loadPumpPool(conn, address) }
    : dex === 'raydium-v4' ? { kind: 'ray', p: await loadRayV4Pool(conn, address) }
    : dex === 'orca-wp' ? { kind: 'wp', p: await loadWhirlpool(conn, address) }
    : dex === 'raydium-clmm' ? { kind: 'clmm', p: await loadClmm(conn, address) }
    : { kind: 'dlmm', p: await loadDlmmPool(conn, address) };
  poolCache.set(key, loaded);
  return loaded;
}
// Cached-only lookup: returns null instead of touching the network.
export const cachedPool = (address: PublicKey): LocalPoolAccts | null => poolCache.get(address.toBase58()) ?? null;
// Keep the mutable bits in step with the watcher's live state (no RPC).
export function refreshHot(address: PublicKey, live: { activeId?: number; tickCurrent?: number }): void {
  const c = poolCache.get(address.toBase58());
  if (!c) return;
  if (c.kind === 'dlmm' && live.activeId !== undefined) c.p.activeId = live.activeId;
  if (c.kind === 'wp' && live.tickCurrent !== undefined) c.p.tickCurrent = live.tickCurrent;
  if (c.kind === 'clmm' && live.tickCurrent !== undefined) c.p.tickCurrent = live.tickCurrent;
}
function tokenMintOf(a: LocalPoolAccts): [PublicKey, PublicKey] { // [mint, tokenProgram]
  if (a.kind === 'pump') return a.p.baseMint.equals(NATIVE_MINT) ? [a.p.quoteMint, a.p.quoteTokenProgram] : [a.p.baseMint, a.p.baseTokenProgram];
  if (a.kind === 'ray') return [a.p.baseMint.equals(NATIVE_MINT) ? a.p.quoteMint : a.p.baseMint, TOKEN_PROGRAM_ID];
  if (a.kind === 'wp') return [a.p.mintA.equals(NATIVE_MINT) ? a.p.mintB : a.p.mintA, a.p.tokenProgram];
  if (a.kind === 'clmm') return [a.p.mint0.equals(NATIVE_MINT) ? a.p.mint1 : a.p.mint0, a.p.tokenProgram];
  return a.p.tokenY.equals(NATIVE_MINT) ? [a.p.tokenX, a.p.progX] : [a.p.tokenY, a.p.progY];
}
// Which bin arrays exist is discovered by the pricing engine (it loads them to
// walk bins) and remembered here, so the build path never probes over RPC.
const binArrayExists = new Map<string, boolean>();
export const noteBinArray = (pool: PublicKey, index: number, exists: boolean) =>
  binArrayExists.set(`${pool.toBase58()}:${index}`, exists);
async function dlmmBinArraysFor(conn: Connection, p: DlmmPoolAccounts, solIn: boolean): Promise<PublicKey[]> {
  const solIsY = p.tokenY.equals(NATIVE_MINT);
  const up = solIn === solIsY;
  const idx = Math.floor(p.activeId / 70);
  const cand = up ? [idx, idx + 1, idx + 2] : [idx, idx - 1, idx - 2];
  const known = cand.map((i) => binArrayExists.get(`${p.pool.toBase58()}:${i}`));
  if (known.every((k) => k !== undefined)) {
    return cand.filter((_, i) => known[i]).map((i) => dlmmBinArrayPda(p.pool, i));
  }
  const pdas = cand.map((i) => dlmmBinArrayPda(p.pool, i));
  const infos = await conn.getMultipleAccountsInfo(pdas);
  cand.forEach((i, k) => binArrayExists.set(`${p.pool.toBase58()}:${i}`, !!infos[k]));
  return pdas.filter((_, i) => !!infos[i]);
}
// One swap instruction for a local pool. side 'buy' = SOL in.
async function swapIxFor(conn: Connection, a: LocalPoolAccts, user: PublicKey, userTok: PublicKey, userWsol: PublicKey, side: 'buy' | 'sell', amountIn: bigint, minOutOrBaseOut: bigint): Promise<TransactionInstruction> {
  if (a.kind === 'pump') {
    const t = await pumpTemplate(conn, a.p, user, side);
    if (!t) throw new Error(`pump template unavailable for ${a.p.pool.toBase58().slice(0, 6)} — leg must go via Jupiter`);
    return side === 'buy' ? pumpBuyIx(a.p, user, minOutOrBaseOut, amountIn, t) : pumpSellIx(a.p, user, amountIn, minOutOrBaseOut, t);
  }
  if (a.kind === 'ray') return side === 'buy' ? rayV4SwapBaseInIx(a.p, user, userWsol, userTok, amountIn, minOutOrBaseOut) : rayV4SwapBaseInIx(a.p, user, userTok, userWsol, amountIn, minOutOrBaseOut);
  if (a.kind === 'wp') {
    const solIsA = a.p.mintA.equals(NATIVE_MINT);
    const aToB = side === 'buy' ? solIsA : !solIsA;
    const [userA, userB] = solIsA ? [userWsol, userTok] : [userTok, userWsol];
    return whirlpoolSwapIx(a.p, user, userA, userB, aToB, amountIn, minOutOrBaseOut);
  }
  if (a.kind === 'clmm') {
    const solIs0 = a.p.mint0.equals(NATIVE_MINT);
    const zeroForOne = side === 'buy' ? solIs0 : !solIs0;
    return clmmSwapIx(a.p, user, side === 'buy' ? userWsol : userTok, side === 'buy' ? userTok : userWsol, zeroForOne, amountIn, minOutOrBaseOut);
  }
  const arrays = await dlmmBinArraysFor(conn, a.p, side === 'buy');
  return side === 'buy' ? dlmmSwap2Ix(a.p, user, userWsol, userTok, amountIn, minOutOrBaseOut, arrays) : dlmmSwap2Ix(a.p, user, userTok, userWsol, amountIn, minOutOrBaseOut, arrays);
}

export async function buildRoundTripTx(
  conn: Connection, wallet: Keypair, buy: LocalPoolAccts, sell: LocalPoolAccts,
  inLamports: bigint, tokAmount: bigint, minOutLamports: bigint, tipLamports: number, tipAccount: PublicKey, blockhash: string,
  alt: AddressLookupTableAccount | null = null,
): Promise<VersionedTransaction | null> {
  const user = wallet.publicKey;
  const [mint, prog] = tokenMintOf(buy);
  const userTok = getAssociatedTokenAddressSync(mint, user, false, prog);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(user, userTok, user, mint, prog),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: inLamports }),
    createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
    await swapIxFor(conn, buy, user, userTok, userWsol, 'buy', inLamports, tokAmount),
    await swapIxFor(conn, sell, user, userTok, userWsol, 'sell', tokAmount, minOutLamports),
    createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: tipAccount, lamports: tipLamports }),
  ];
  try {
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    return tx.serialize().length <= 1232 ? tx : null;
  } catch {
    return null; // "encoding overruns" = too big without (more) lookup-table coverage
  }
}

// Static account keys a round trip through these pools touches — candidates
// for the address lookup table (see alt.ts).
export function staticKeysFor(a: LocalPoolAccts, user: PublicKey): PublicKey[] {
  const keys: PublicKey[] = [SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
    getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID)];
  const [mint, prog] = tokenMintOf(a);
  keys.push(mint, getAssociatedTokenAddressSync(mint, user, false, prog));
  if (a.kind === 'pump') {
    const c = commonAccounts(a.p, user);
    keys.push(a.p.pool, a.p.baseVault, a.p.quoteVault, PUMP_GLOBAL_CONFIG, PUMP_PROTOCOL_FEE_RECIPIENT, c.protocolFeeAta, c.eventAuthority, PUMP_AMM,
      c.creatorVaultAta, c.creatorVaultAuth, c.globalVol, c.userVol, c.feeConfig, PUMP_FEE_PROGRAM, PUMP_OPTIONAL_PLACEHOLDER, PUMP_FEE_SHARE, c.feeShareAta);
  } else if (a.kind === 'ray') {
    keys.push(a.p.pool, a.p.baseVault, a.p.quoteVault, RAY_V4, RAY_V4_AUTHORITY);
  } else if (a.kind === 'wp') {
    keys.push(a.p.pool, a.p.vaultA, a.p.vaultB, a.p.oracle, WHIRLPOOL_PROG);
  } else if (a.kind === 'clmm') {
    keys.push(a.p.pool, a.p.ammConfig, a.p.vault0, a.p.vault1, a.p.observation, a.p.bitmapExt, CLMM_PROG);
  } else {
    keys.push(a.p.pool, a.p.reserveX, a.p.reserveY, a.p.oracle, DLMM_PROG, MEMO_PROG, pda([Buffer.from('__event_authority')], DLMM_PROG));
    if (a.p.bitmapExt) keys.push(a.p.bitmapExt);
  }
  return keys;
}

// =============================================================================
// Orca Whirlpool (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc) — legacy `swap`
//   [token_prog, user, whirlpool, user_a, vault_a, user_b, vault_b, tick0, tick1, tick2, oracle]
//   data = disc + amount u64 + other_amount_threshold u64 + sqrt_price_limit u128 + is_input(1) + a_to_b(1)
//   tick arrays: 88*tickSpacing ticks each, PDA("tick_array", pool, startIndex as decimal string)
// =============================================================================
export const WHIRLPOOL_PROG = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const DISC_WP_SWAP = Buffer.from('f8c69e91e17587c8', 'hex');
const MIN_SQRT_PRICE = 4295048016n, MAX_SQRT_PRICE = 79226673515401279992447579055n;
const u128le = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn); b.writeBigUInt64LE(n >> 64n, 8); return b; };

export interface WhirlpoolAccounts { pool: PublicKey; mintA: PublicKey; mintB: PublicKey; vaultA: PublicKey; vaultB: PublicKey; tickSpacing: number; tickCurrent: number; oracle: PublicKey; tokenProgram: PublicKey }
export async function loadWhirlpool(conn: Connection, pool: PublicKey): Promise<WhirlpoolAccounts> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(WHIRLPOOL_PROG)) throw new Error('not a whirlpool');
  const d = info.data;
  const mintA = new PublicKey(d.subarray(101, 133)), mintB = new PublicKey(d.subarray(181, 213));
  // The legacy `swap` takes ONE token program: it is only valid when both mints
  // are classic SPL-Token. Token-2022 pools need swapV2 (not implemented) — we
  // record the program so callers can refuse rather than build an invalid tx.
  const [ia, ib] = await conn.getMultipleAccountsInfo([mintA, mintB]);
  const tokenProgram = (ia?.owner.equals(TOKEN_PROGRAM_ID) && ib?.owner.equals(TOKEN_PROGRAM_ID)) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  return { pool, tickSpacing: d.readUInt16LE(41), tickCurrent: d.readInt32LE(81), mintA, vaultA: new PublicKey(d.subarray(133, 165)),
    mintB, vaultB: new PublicKey(d.subarray(213, 245)), oracle: pda([Buffer.from('oracle'), pool.toBuffer()], WHIRLPOOL_PROG), tokenProgram };
}
export function whirlpoolTickArrays(p: WhirlpoolAccounts, aToB: boolean): PublicKey[] {
  const span = 88 * p.tickSpacing;
  const start = Math.floor(p.tickCurrent / span) * span;
  return [0, 1, 2].map((i) => pda([Buffer.from('tick_array'), p.pool.toBuffer(), Buffer.from(String(start + (aToB ? -i : i) * span))], WHIRLPOOL_PROG));
}
export function whirlpoolSwapIx(p: WhirlpoolAccounts, user: PublicKey, userA: PublicKey, userB: PublicKey, aToB: boolean, amountIn: bigint, minOut: bigint): TransactionInstruction {
  const [t0, t1, t2] = whirlpoolTickArrays(p, aToB);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROG,
    keys: [r(TOKEN_PROGRAM_ID), r(user, true), w(p.pool), w(userA), w(p.vaultA), w(userB), w(p.vaultB), w(t0), w(t1), w(t2), w(p.oracle)],
    data: Buffer.concat([DISC_WP_SWAP, u64le(amountIn), u64le(minOut), u128le(aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE), Buffer.from([1, aToB ? 1 : 0])]),
  });
}

// =============================================================================
// Raydium CLMM (CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK) — legacy `swap`
//   [payer, amm_config, pool, user_in, user_out, vault_in, vault_out, observation, token_prog, tick_array0,
//    ...remaining: bitmap_extension, tick_array1, tick_array2]
//   data = disc + amount u64 + other_amount_threshold u64 + sqrt_price_limit_x64 u128 (0 = default) + is_base_input(1)
//   tick arrays: 60*tickSpacing ticks each, PDA("tick_array", pool, startIndex i32 BE)
// =============================================================================
export const CLMM_PROG = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export interface ClmmAccounts { pool: PublicKey; ammConfig: PublicKey; mint0: PublicKey; mint1: PublicKey; vault0: PublicKey; vault1: PublicKey; observation: PublicKey; tickSpacing: number; tickCurrent: number; bitmapExt: PublicKey; tokenProgram: PublicKey }
export async function loadClmm(conn: Connection, pool: PublicKey): Promise<ClmmAccounts> {
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(CLMM_PROG)) throw new Error('not a raydium clmm pool');
  const d = info.data;
  const mint0 = new PublicKey(d.subarray(73, 105)), mint1 = new PublicKey(d.subarray(105, 137));
  const [i0, i1] = await conn.getMultipleAccountsInfo([mint0, mint1]);
  const tokenProgram = (i0?.owner.equals(TOKEN_PROGRAM_ID) && i1?.owner.equals(TOKEN_PROGRAM_ID)) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  return { pool, ammConfig: new PublicKey(d.subarray(9, 41)), mint0, mint1, vault0: new PublicKey(d.subarray(137, 169)), vault1: new PublicKey(d.subarray(169, 201)),
    observation: new PublicKey(d.subarray(201, 233)), tickSpacing: d.readUInt16LE(235), tickCurrent: d.readInt32LE(269), bitmapExt: pda([Buffer.from('pool_tick_array_bitmap_extension'), pool.toBuffer()], CLMM_PROG), tokenProgram };
}
export function clmmTickArrays(p: ClmmAccounts, zeroForOne: boolean): PublicKey[] {
  const span = 60 * p.tickSpacing;
  const start = Math.floor(p.tickCurrent / span) * span;
  return [0, 1, 2].map((i) => { const b = Buffer.alloc(4); b.writeInt32BE(start + (zeroForOne ? -i : i) * span); return pda([Buffer.from('tick_array'), p.pool.toBuffer(), b], CLMM_PROG); });
}
export function clmmSwapIx(p: ClmmAccounts, user: PublicKey, userIn: PublicKey, userOut: PublicKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): TransactionInstruction {
  const [t0, t1, t2] = clmmTickArrays(p, zeroForOne);
  return new TransactionInstruction({
    programId: CLMM_PROG,
    keys: [w(user, true), r(p.ammConfig), w(p.pool), w(userIn), w(userOut), w(zeroForOne ? p.vault0 : p.vault1), w(zeroForOne ? p.vault1 : p.vault0), w(p.observation), r(TOKEN_PROGRAM_ID),
      w(t0), w(p.bitmapExt), w(t1), w(t2)],
    data: Buffer.concat([DISC_WP_SWAP, u64le(amountIn), u64le(minOut), u128le(0n), Buffer.from([1])]),
  });
}

// Generic single-leg tx for any local pool (2-tx bundle fallback path).
export async function buildLegTx(conn: Connection, wallet: Keypair, a: LocalPoolAccts, side: 'buy' | 'sell', amountIn: bigint, minOutOrBaseOut: bigint, blockhash: string, extraIxs: TransactionInstruction[] = []): Promise<VersionedTransaction> {
  const user = wallet.publicKey;
  const [mint, prog] = tokenMintOf(a);
  const userTok = getAssociatedTokenAddressSync(mint, user, false, prog);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(user, userTok, user, mint, prog),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
  ];
  if (side === 'buy') { ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: amountIn }), createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID)); }
  ixs.push(await swapIxFor(conn, a, user, userTok, userWsol, side, amountIn, minOutOrBaseOut));
  ixs.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID), ...extraIxs);
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([wallet]); return tx;
}

// =============================================================================
// PumpSwap account templating from Jupiter. The tail of PumpSwap's account list
// includes a per-pool `pool_v2` address (uninitialised, scheme unknown) and a
// market-cap fee-tier account + its WSOL ATA that change over time. Instead of
// guessing PDAs, copy the exact CPI account slice from a Jupiter-built swap for
// this pool (Jupiter's route ix passes hop accounts in CPI order). Cached.
// =============================================================================
import { quote as jupQuote, buildSwapTx as jupBuildSwapTx } from './jupiter.js';
const JUPITER_PROG = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const pumpTemplates = new Map<string, { buy?: PumpTpl; sell?: PumpTpl; at: number }>();
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PumpTpl { keys: PublicKey[]; writable: boolean[] }
import bs58 from 'bs58';

// Ground truth: simulate a Jupiter-built swap with innerInstructions and copy
// the exact PumpSwap CPI it emits (accounts + writability). Data layout observed:
//   buy_exact_quote_in(quote_amount_in u64, min_base_amount_out u64)  — 24 bytes, disc c62e1552b4d9e870
async function jupiterPumpCpi(conn: Connection, inMint: string, outMint: string, amount: bigint, user: PublicKey): Promise<PumpTpl | null> {
  const q = await jupQuote(inMint, outMint, amount, { dexes: 'Pump.fun Amm', onlyDirectRoutes: 'true' });
  if (!q) return null;
  const b64 = await jupBuildSwapTx(q, user.toBase58(), 0);
  if (!b64) return null;
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const msg = tx.message;
  const ordered: PublicKey[] = [...msg.staticAccountKeys];
  const tables = await Promise.all(msg.addressTableLookups.map((l) => conn.getAddressLookupTable(l.accountKey)));
  msg.addressTableLookups.forEach((l, ti) => { const a = tables[ti].value?.state.addresses ?? []; for (const i of l.writableIndexes) ordered.push(a[i]); });
  msg.addressTableLookups.forEach((l, ti) => { const a = tables[ti].value?.state.addresses ?? []; for (const i of l.readonlyIndexes) ordered.push(a[i]); });
  const wmap = new Map(ordered.map((k, i) => [k.toBase58(), msg.isAccountWritable(i)]));
  const r = await fetch((conn as unknown as { _rpcEndpoint: string })._rpcEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', innerInstructions: true }] }),
  });
  const j = (await r.json()) as { result?: { value: { innerInstructions?: Array<{ instructions: Array<{ programId: string; accounts: string[]; data: string }> }> } } };
  for (const g of j.result?.value.innerInstructions ?? []) for (const ix of g.instructions) {
    if (ix.programId !== PUMP_AMM.toBase58()) continue;
    const disc = Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex');
    if (disc !== 'c62e1552b4d9e870') continue; // buy_exact_quote_in
    return { keys: ix.accounts.map((k) => new PublicKey(k)), writable: ix.accounts.map((k) => wmap.get(k) ?? false) };
  }
  return null;
}

// Exact PumpSwap accounts for this pool: buy from the live CPI; sell = buy minus the two
// volume-accumulator slots ([19] global, [20] user), per the on-chain sell layout. Cached 5 min.
export async function pumpTemplate(conn: Connection, p: PumpPoolAccounts, user: PublicKey, side: 'buy' | 'sell', refresh = false): Promise<PumpTpl | null> {
  const key = p.pool.toBase58();
  const c = pumpTemplates.get(key);
  if (!refresh && c && Date.now() - c.at < 300_000 && c.buy) return side === 'buy' ? c.buy : c.sell ?? null;
  const tokenMint = p.baseMint.equals(NATIVE_MINT) ? p.quoteMint : p.baseMint;
  try {
    const buy = await jupiterPumpCpi(conn, SOL_MINT, tokenMint.toBase58(), 10_000_000n, user);
    if (!buy) {
      // Fetch failed (rate limit, Jupiter hiccup): keep serving the previous
      // template rather than dropping to "no template" — a slightly stale layout
      // beats no local build, and the next refresh will retry.
      return c?.buy ? (side === 'buy' ? c.buy : c.sell ?? null) : null;
    }
    const sell: PumpTpl = { keys: buy.keys.filter((_, i) => i !== 19 && i !== 20), writable: buy.writable.filter((_, i) => i !== 19 && i !== 20) };
    pumpTemplates.set(key, { at: Date.now(), buy, sell });
    return side === 'buy' ? buy : sell;
  } catch { return c?.buy ? (side === 'buy' ? c.buy : c.sell ?? null) : null; }
}
// True when a fresh CPI template exists for this pool. Without one we do NOT
// build a PumpSwap leg locally: the hand-written legacy layout is known-stale
// (PumpSwap changed its instruction mid-session on 2026-08-15) and would only
// waste a send. Callers route that leg through Jupiter instead.
export function hasPumpTemplate(pool: PublicKey): boolean {
  const c = pumpTemplates.get(pool.toBase58());
  return !!c?.buy && Date.now() - c.at < 900_000;
}
export function pumpTemplateSizes(): string { return [...pumpTemplates.entries()].map(([k, v]) => `${k.slice(0, 6)}:${v.buy ? 'B' : '-'}${v.sell ? 'S' : '-'}`).join(' '); }

// Pre-warm / refresh PumpSwap CPI templates so fire-time builds never wait on Jupiter.
export async function warmPumpTemplates(conn: Connection, user: PublicKey, pools: Array<{ dex: string; address: PublicKey }>, force = false): Promise<void> {
  for (const p of pools) {
    if (p.dex !== 'pumpswap') continue;
    try {
      const acc = await loadPumpPool(conn, p.address);
      // Replace-on-success: the old template stays live until the new one lands,
      // so a refresh never opens a window where the leg has no template.
      const t = await pumpTemplate(conn, acc, user, 'buy', force);
      console.log(`  pump template ${p.address.toBase58().slice(0, 6)}…: ${t ? `${t.keys.length} accts` : 'FAILED — pump legs for this pool go via Jupiter until the next refresh'}`);
    } catch (e) { console.warn(`  pump template ${p.address.toBase58().slice(0, 6)}… failed: ${(e as Error).message.slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
