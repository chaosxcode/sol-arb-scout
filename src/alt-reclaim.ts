// Deactivate + close the address lookup table, returning its rent to the wallet.
// Solana requires a cooldown (~1 epoch boundary / a few minutes) between
// deactivate and close, so this is safe to re-run: it does whichever step is due.
import { AddressLookupTableProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { CFG } from './config.js';
import { fmtSol, loadWallet } from './executor.js';

const conn = new Connection(CFG.rpcUrl, 'confirmed');
const wallet = loadWallet();
if (!existsSync('./.alt.json')) { console.log('no .alt.json — nothing to reclaim'); process.exit(0); }
const address = new PublicKey((JSON.parse(readFileSync('./.alt.json', 'utf8')) as { address: string }).address);

const send = async (ix: Parameters<typeof TransactionMessage.prototype.compileToV0Message> extends never ? never : import('@solana/web3.js').TransactionInstruction) => {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
};

const before = await conn.getBalance(wallet.publicKey);
const info = await conn.getAddressLookupTable(address);
if (!info.value) { console.log('table already closed'); unlinkSync('./.alt.json'); process.exit(0); }
const state = info.value.state;
console.log(`ALT ${address.toBase58()} | ${state.addresses.length} addresses | rent ${fmtSol((await conn.getAccountInfo(address))!.lamports)} SOL`);

if (state.deactivationSlot === BigInt('18446744073709551615')) {
  const sig = await send(AddressLookupTableProgram.deactivateLookupTable({ lookupTable: address, authority: wallet.publicKey }));
  console.log(`deactivated (${sig.slice(0, 12)}…). Rent is returned by re-running this after the cooldown (~2-5 min).`);
  process.exit(0);
}
try {
  const sig = await send(AddressLookupTableProgram.closeLookupTable({ lookupTable: address, authority: wallet.publicKey, recipient: wallet.publicKey }));
  const after = await conn.getBalance(wallet.publicKey);
  console.log(`CLOSED (${sig.slice(0, 12)}…) — recovered ${fmtSol(after - before)} SOL | wallet now ${fmtSol(after)} SOL`);
  unlinkSync('./.alt.json');
} catch (e) {
  console.log(`close not yet permitted (cooldown still running): ${(e as Error).message.slice(0, 120)}`);
  console.log('re-run `npm run alt-reclaim` in a few minutes.');
}
