// Address lookup table for our local pools: makes single-tx round trips fit.
// Created once (address persisted in .alt.json), extended as new keys appear.
// Rent (~0.00022 SOL per address) is reclaimable: deactivate + close later.
import {
  AddressLookupTableAccount, AddressLookupTableProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CFG } from './config.js';

const FILE = './.alt.json';

async function sendIxs(conn: Connection, wallet: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

export async function ensureAlt(conn: Connection, wallet: Keypair, wanted: PublicKey[]): Promise<AddressLookupTableAccount | null> {
  try {
    if (CFG.altMaxAddresses <= 0) { console.log('  ALT disabled (ALT_MAX_ADDRESSES=0) — round trips use the 2-tx bundle when too large for one tx'); return null; }
    // Budget: never lock more than altMaxWalletShare of the wallet in table rent.
    const bal = await conn.getBalance(wallet.publicKey);
    const perAddr = 6960 * 32; // lamports of rent per stored address (approx)
    const affordable = Math.floor((bal * CFG.altMaxWalletShare) / perAddr);
    const budget = Math.max(0, Math.min(CFG.altMaxAddresses, affordable, 250));
    if (budget < 16) { console.log(`  ALT skipped: wallet ${(bal / 1e9).toFixed(4)} SOL only affords ${budget} addresses`); return null; }
    if (wanted.length > budget) {
      console.log(`  ALT budget ${budget} addresses (of ${wanted.length} candidates; rent ≈ ${((56 + 32 * budget) * 6960 / 1e9).toFixed(4)} SOL)`);
      wanted = wanted.slice(0, budget);
    }
    let address: PublicKey | null = existsSync(FILE) ? new PublicKey((JSON.parse(readFileSync(FILE, 'utf8')) as { address: string }).address) : null;
    if (address) {
      const cur = await conn.getAddressLookupTable(address);
      if (!cur.value) address = null; // gone (closed?) -> recreate
    }
    if (!address) {
      const slot = await conn.getSlot('finalized');
      const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
      const sig = await sendIxs(conn, wallet, [ix]);
      address = addr;
      writeFileSync(FILE, JSON.stringify({ address: addr.toBase58(), created: new Date().toISOString(), sig }));
      console.log(`  ALT created ${addr.toBase58()} (${sig.slice(0, 10)}…)`);
    }
    let table = (await conn.getAddressLookupTable(address)).value!;
    const have = new Set(table.state.addresses.map((k) => k.toBase58()));
    const uniq = [...new Map(wanted.map((k) => [k.toBase58(), k])).values()].filter((k) => !have.has(k.toBase58()));
    for (let i = 0; i < uniq.length; i += 20) {
      const chunk = uniq.slice(i, i + 20);
      const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: wallet.publicKey, payer: wallet.publicKey, addresses: chunk });
      const sig = await sendIxs(conn, wallet, [ix]);
      console.log(`  ALT extended +${chunk.length} (${sig.slice(0, 10)}…)`);
    }
    if (uniq.length) table = (await conn.getAddressLookupTable(address)).value!;
    console.log(`  ALT ${address.toBase58().slice(0, 8)}… holds ${table.state.addresses.length} addresses (rent ≈ ${((56 + 32 * table.state.addresses.length) * 6960 / 1e9).toFixed(4)} SOL, reclaimable)`);
    return table;
  } catch (e) {
    console.warn('  ALT setup failed (single-tx round trips limited to what fits without it):', (e as Error).message.slice(0, 120));
    return null;
  }
}
