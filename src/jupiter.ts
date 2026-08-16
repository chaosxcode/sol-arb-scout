import { CFG } from './config.js';

// Jupiter aggregates every major Solana DEX. A single quote already routes
// through multi-hop paths — Jupiter's route IS your "triangle".
export interface Quote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string; // ExactIn: the on-chain minimum out (worst case)
  slippageBps: number;
  [k: string]: unknown;
}

// ---- Adaptive rate limiter, multi-lane -------------------------------------
// Throughput is bounded by Jupiter's quota, not CPU. Two independent buckets:
//   lane 0: api.jup.ag with your key  (free tier: 10 req / 10 s, sends
//           x-ratelimit-* headers we pace by)
//   lane 1: lite-api.jup.ag, no key   (per-IP, ~0.5-1 req/s sustained, no
//           headers -> flat backoff on 429)          [JUP_LITE_ASSIST=true]
// Each request goes to whichever lane is free soonest. Failures stay LOUD.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Lane { name: string; base: string; key?: string; pausedUntil: number; used: number; hits429: number }
const lanes: Lane[] = [{ name: CFG.jupApiKey ? 'api' : 'lite', base: CFG.jupBase, key: CFG.jupApiKey || undefined, pausedUntil: 0, used: 0, hits429: 0 }];
if (CFG.jupApiKey && CFG.jupLiteAssist && !CFG.jupBase.includes('lite-api')) {
  lanes.push({ name: 'lite', base: 'https://lite-api.jup.ag/swap/v1', pausedUntil: 0, used: 0, hits429: 0 });
}
export const laneStats = () => lanes.map((l) => `${l.name}:${l.used}${l.hits429 ? `(${l.hits429}x429)` : ''}`).join(' ');

let lastWarn = 0;
function warn(msg: string): void {
  const now = Date.now();
  if (now - lastWarn < 5_000) return; // don't spam
  lastWarn = now;
  console.warn('  ' + msg);
}

function pickLane(): Lane {
  // Soonest-free lane; on a tie prefer the keyed lane (predictable headers).
  return lanes.reduce((a, b) => (b.pausedUntil < a.pausedUntil ? b : a), lanes[0]);
}

async function jupFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lane = pickLane();
    const wait = lane.pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (lane.key) headers['x-api-key'] = lane.key;
    const r = await fetch(lane.base + path, { ...init, headers });
    lane.used++;

    // Pace proactively from headers when present (keyed lane).
    const remaining = Number(r.headers.get('x-ratelimit-remaining') ?? NaN);
    const resetSec = Number(r.headers.get('x-ratelimit-reset') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 0 && !Number.isNaN(resetSec)) {
      lane.pausedUntil = resetSec * 1000 + 250;
    }

    if (r.status === 429) {
      lane.hits429++;
      const until = !Number.isNaN(resetSec) ? resetSec * 1000 + 250 : Date.now() + 8_000;
      lane.pausedUntil = Math.max(lane.pausedUntil, until);
      if (lanes.length === 1 || attempt === 2) {
        warn(
          `Jupiter 429 on ${lane.name} — pausing that lane ${Math.ceil((lane.pausedUntil - Date.now()) / 1000)}s` +
            (CFG.jupApiKey ? ' (free key ≈ 60 req/min; upgrade at portal.jup.ag for 10x)' : ' (set JUP_API_KEY from portal.jup.ag)'),
        );
      }
      continue; // retry on whichever lane is free soonest
    }
    if (!r.ok) {
      warn(
        `Jupiter HTTP ${r.status} on ${lane.name}${path.split('?')[0]}` +
          (r.status === 404 ? ' (endpoint moved? check JUP_BASE at dev.jup.ag)' : '') +
          (r.status === 401 || r.status === 403 ? ' (bad/expired JUP_API_KEY?)' : ''),
      );
      return null;
    }
    return r;
  }
  return null; // every lane throttled — skip this call, next scan retries
}

export async function quote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  extra: Record<string, string> = {},
): Promise<Quote | null> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(CFG.slippageBps),
    // Jupiter rejects dexes+excludeDexes together; a pinned (dexes=) probe wins.
    ...(CFG.jupExcludeDexes && !extra.dexes ? { excludeDexes: CFG.jupExcludeDexes } : {}),
    ...extra,
  });
  const r = await jupFetch('/quote?' + qs.toString());
  if (!r) return null;
  return (await r.json()) as Quote;
}

// prioritization:
//   0                          -> no priority fee (a Jito bundle doesn't need one;
//                                 Jupiter's default 'auto' silently adds ~20k lamports)
//   { jitoTipLamports: N }     -> Jupiter appends the Jito tip transfer INSIDE this
//                                 tx, so the bundle needs no separate tip tx
export async function buildSwapTx(
  quoteResponse: Quote,
  userPublicKey: string,
  prioritization: 0 | { jitoTipLamports: number } = 0,
): Promise<string | null> {
  const r = await jupFetch('/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: prioritization,
    }),
  });
  if (!r) return null;
  const j = (await r.json()) as { swapTransaction?: string };
  return j.swapTransaction ?? null;
}
