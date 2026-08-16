import { Keypair } from '@solana/web3.js';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('./wallet.json')) {
  console.error('wallet.json already exists — refusing to overwrite.');
  process.exit(1);
}

const kp = Keypair.generate();
writeFileSync('./wallet.json', JSON.stringify(Array.from(kp.secretKey)));
console.log('New BURNER wallet created: wallet.json');
console.log('Public key:', kp.publicKey.toBase58());
console.log('Fund it with a FEW dollars of SOL only. Never reuse a main wallet here.');
