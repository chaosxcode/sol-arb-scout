// Hot-path caches: everything the firing path used to fetch synchronously.
//
// Firing a trade used to cost two RPC round-trips before a single byte hit the
// wire — getLatestBlockhash (~100-200ms on free RPC) and per-pool getAccountInfo.
// Both are now refreshed in the background, so building a signed round trip is
// pure CPU (~1ms). On a race decided in tens of milliseconds this is the single
// biggest self-inflicted delay we can remove.
import { Connection } from '@solana/web3.js';

let blockhash = '';
let blockhashAt = 0;
let timer: NodeJS.Timeout | null = null;

export function startBlockhashPump(conn: Connection, intervalMs = 2000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await conn.getLatestBlockhash('confirmed');
      blockhash = r.blockhash;
      blockhashAt = Date.now();
    } catch { /* keep the previous one; blockhashes stay valid ~60s */ }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
}

// Freshest blockhash we have. Falls back to a live fetch only if the pump has
// not produced one yet (first seconds of the process).
export async function hotBlockhash(conn: Connection): Promise<string> {
  if (blockhash && Date.now() - blockhashAt < 45_000) return blockhash;
  const r = await conn.getLatestBlockhash('confirmed');
  blockhash = r.blockhash;
  blockhashAt = Date.now();
  return blockhash;
}
export const blockhashAgeMs = () => (blockhashAt ? Date.now() - blockhashAt : -1);
