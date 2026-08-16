import { CFG } from './config.js';

// Well-known Jito tip accounts. Verified against getTipAccounts on 2026-08-15.
// (Only used by the non-embedded tip path; normally Jupiter embeds the tip.)
export const TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
];

async function rpcAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`Jito ${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return rpcAt<T>(CFG.jitoUrl, method, params);
}

// Bundles are atomic: every tx lands in order, or none do.
//
// The same bundle is submitted to several block-engine regions at once. Only one
// can land (identical transactions -> identical signatures; the rest are dropped
// as duplicates), but whichever region's leader is next gets it soonest. Measured
// round-trips from this host: mainnet 187ms, ny 247ms, slc 321ms, eu 400ms+.
export async function sendBundle(base58Txs: string[]): Promise<string> {
  const urls = CFG.jitoUrls;
  if (urls.length <= 1) return rpc<string>('sendBundle', [base58Txs]);
  const results = await Promise.allSettled(urls.map((u) => rpcAt<string>(u, 'sendBundle', [base58Txs])));
  const ok = results.find((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
  if (ok) {
    const nOk = results.filter((r) => r.status === 'fulfilled').length;
    if (nOk < urls.length) {
      const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      lastRegionWarn = lastRegionWarn || 0;
      if (Date.now() - lastRegionWarn > 30_000) {
        lastRegionWarn = Date.now();
        console.warn(`  (${nOk}/${urls.length} Jito regions accepted; e.g. ${String(err?.reason).slice(0, 90)})`);
      }
    }
    return ok.value;
  }
  throw new Error(String((results[0] as PromiseRejectedResult).reason).replace(/^Error: /, ''));
}
let lastRegionWarn = 0;

// ---- Tip floor -----------------------------------------------------------
// Jito publishes what tips actually landed recently. A flat tip either
// overpays 40x in quiet slots or never lands in busy ones; we bid from the
// live distribution and let the fee math decide which percentile we can afford.
export interface TipFloor {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  ema50: number;
} // all lamports

let tipCache: { at: number; v: TipFloor } | null = null;
export async function getTipFloor(): Promise<TipFloor> {
  if (tipCache && Date.now() - tipCache.at < 20_000) return tipCache.v;
  try {
    const r = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const [d] = (await r.json()) as Record<string, number>[];
    const L = (sol: number) => Math.max(1000, Math.round(sol * 1e9));
    const v = {
      p25: L(d.landed_tips_25th_percentile),
      p50: L(d.landed_tips_50th_percentile),
      p75: L(d.landed_tips_75th_percentile),
      p95: L(d.landed_tips_95th_percentile),
      ema50: L(d.ema_landed_tips_50th_percentile),
    };
    tipCache = { at: Date.now(), v };
    return v;
  } catch {
    // Endpoint hiccup: fall back to the configured flat tip for every rung.
    const t = CFG.jitoTipLamports;
    return tipCache?.v ?? { p25: t, p50: t, p75: t, p95: t, ema50: t };
  }
}
