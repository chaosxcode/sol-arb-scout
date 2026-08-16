// Keep the Jito connections hot.
//
// Measured from this host: a bundle POST to the NY block engine costs ~170ms
// total, but only ~44ms of that is the actual network round trip. The rest is
// DNS (~27ms) plus a TLS handshake (~55ms) that we were paying on almost every
// submission, because fires are seconds apart and the default connection pool
// closes idle sockets after ~4s.
//
// Holding warm, pre-authenticated sockets to each region removes that ~100ms
// from the critical path — comparable to the gain from physically relocating
// the machine, for free. A low-rate warm ping keeps them from going idle.
import { Agent, setGlobalDispatcher } from 'undici';
import { CFG } from './config.js';

let started = false;

export function startWire(): void {
  if (started) return;
  started = true;
  // Long keep-alive, generous pool: sockets stay open and TLS stays negotiated.
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 8,
    pipelining: 1,
  }));

  const warm = async () => {
    await Promise.allSettled(CFG.jitoUrls.map((u) =>
      fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
      }).then((r) => r.arrayBuffer()).catch(() => null),
    ));
  };
  void warm();
  setInterval(() => void warm(), 20_000); // well inside the keep-alive window
  console.log(`wire: holding warm TLS connections to ${CFG.jitoUrls.length} Jito regions (saves ~100ms/submit)`);
}

// One-shot measurement of what a warm connection actually costs.
export async function probeWarm(url: string): Promise<number> {
  const t0 = performance.now();
  await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
  }).then((r) => r.arrayBuffer()).catch(() => null);
  return performance.now() - t0;
}
