// Reclaim rent from empty token accounts left behind by round trips.
import { Connection } from '@solana/web3.js';
import { CFG } from './config.js';
import { fmtSol, loadWallet, reclaimEmptyTokenAccounts } from './executor.js';

const conn = new Connection(CFG.rpcUrl, 'confirmed');
const wallet = loadWallet();
const before = await conn.getBalance(wallet.publicKey);
console.log(`wallet ${wallet.publicKey.toBase58()} balance ${fmtSol(before)} SOL`);
const got = await reclaimEmptyTokenAccounts(conn, wallet);
const after = await conn.getBalance(wallet.publicKey);
console.log(`reclaimed ${fmtSol(got)} SOL; balance now ${fmtSol(after)} SOL`);
