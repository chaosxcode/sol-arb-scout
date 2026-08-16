import 'dotenv/config';

const num = (k: string, d: number) => Number(process.env[k] ?? d);
const str = (k: string, d: string) => process.env[k] ?? d;
const bool = (k: string, d: boolean) =>
  (process.env[k] ?? String(d)).toLowerCase() === 'true';

export const CFG = {
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  jupApiKey: str('JUP_API_KEY', ''),
  // With a portal.jup.ag key, use api.jup.ag (returns x-ratelimit-* headers
  // the limiter in jupiter.ts uses to pace itself). No key -> lite-api.
  jupBase: str(
    'JUP_BASE',
    process.env.JUP_API_KEY
      ? 'https://api.jup.ag/swap/v1'
      : 'https://lite-api.jup.ag/swap/v1',
  ),
  jupLiteAssist: bool('JUP_LITE_ASSIST', true),
  // DEXes Jupiter must not route through. HumidiFi's accounts include Jito's
  // validator vote account (J1to1yuf…), and Jito rejects any bundle that locks
  // a vote account -> routes via HumidiFi can never land as a bundle.
  // HumidiFi's accounts include Jito's validator vote account, so bundles routed
  // through it are rejected outright. Nexus is an RFQ venue that quoted a price
  // it then refused to honour ("No price for side offer") AND produced a wildly
  // wrong quote (+3,586,618 bps) that our poll path briefly believed. Both are
  // venues that cost us sends without ever being fillable.
  jupExcludeDexes: str('JUP_EXCLUDE_DEXES', 'HumidiFi,Nexus'),
  // Adaptive scheduling: pairs whose last edge was >= HOT_BPS scan every cycle;
  // between HOT and COLD every 3rd; below COLD every 8th. Same request budget,
  // more looks at the pairs that can actually fire.
  // On-chain watcher (WATCH=true): fire a Jupiter check when the live
  // cross-pool mid spread for a token exceeds its trigger (self-calibrating,
  // starts at WATCH_TRIGGER_BPS); at most one check per token per cooldown.
  watch: bool('WATCH', true),
  watchStage1Bps: num('WATCH_STAGE1_BPS', 10),   // mid spread needed to bother pricing locally
  localEvalMs: num('LOCAL_EVAL_MS', 1200),        // max one local pricing per token per this
  localTriggerBps: num('LOCAL_TRIGGER_BPS', 6),   // local exact round trip needed to call Jupiter
  watchBlindBps: num('WATCH_BLIND_BPS', 150),     // not priceable locally but spread this big: one look
  watchCooldownMs: num('WATCH_COOLDOWN_MS', 4000),
  hotBps: num('HOT_BPS', -15),
  coldBps: num('COLD_BPS', -60),
  tradeSizeSol: num('TRADE_SIZE_SOL', 0.02),
  minProfitBps: num('MIN_PROFIT_BPS', 25),
  slippageBps: num('SLIPPAGE_BPS', 30),
  scanIntervalMs: num('SCAN_INTERVAL_MS', 1500),
  dryRun: bool('DRY_RUN', true),
  walletKeypair: str('WALLET_KEYPAIR', './wallet.json'),
  useJito: bool('USE_JITO', true),
  jitoUrl: str(
    'JITO_BLOCK_ENGINE',
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  ),
  // Submit each bundle to every one of these regions in parallel (first leader
  // to see it wins; duplicates are dropped). Measured from this host: mainnet
  // 187ms, ny 247ms, slc 321ms. Override with a comma-separated JITO_REGIONS.
  jitoUrls: str(
    'JITO_REGIONS',
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles,https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles,https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles',
  ).split(',').map((u) => u.trim()).filter(Boolean),
  jitoTipLamports: num('JITO_TIP_LAMPORTS', 100_000), // fallback only; live tips come from Jito's floor
  // A trade must clear tip + fees by at least this many lamports at WORST-CASE
  // fill, or it isn't sent. 0 = "any fraction of a lamport".
  minNetLamports: num('MIN_NET_LAMPORTS', 1000),
  // Share of worst-case profit bid as Jito tip (auction: bid most of it, keep the rest).
  tipShare: num('TIP_SHARE', 0.6),
  // Forensics 2026-08-15: bots that actually landed round trips in our windows
  // tipped median 2.1k, p75 7.7k, max 14.8k lamports. Above that we're only
  // donating profit to the validator; cap the bid.
  tipMaxLamports: num('TIP_MAX_LAMPORTS', 15_000),
  // Upper bound on a proportional bid. Big edges deserve big bids — winning 40%
  // of a 600k-lamport profit beats losing 100% of it.
  tipCeilingLamports: num('TIP_CEILING_LAMPORTS', 400_000),
  // Reject quotes claiming more than this multiple of the input (pricing faults).
  sanityMaxMultiple: num('SANITY_MAX_MULTIPLE', 1),
  maxInflight: num('MAX_INFLIGHT', 3),
  // TRADE_SIZE_SOL is a CAP. Each opportunity is sized by the local engine to
  // whatever maximises profit on that specific dislocation, down to this floor.
  minSizeLamports: num('MIN_SIZE_LAMPORTS', 3_000_000),
  // Buffer on the INTERMEDIATE token amount. The buy leg's on-chain minimum and
  // the sell leg's input are the same number, so it must be low enough that the
  // buy reliably clears it after a tick of pool movement — the sell's break-even
  // minimum is what actually protects profitability, not this.
  buyBufferBps: num('BUY_BUFFER_BPS', 40),
  // ---- automatic token rotation ----
  // The long tail is where tradeable edges live, and it turns over. Re-screen on
  // this interval and adopt anything whose FEE WALL beats the threshold.
  discoverEnabled: bool('DISCOVER', true),
  discoverIntervalMs: num('DISCOVER_INTERVAL_MS', 3_600_000),
  discoverMaxTokens: num('DISCOVER_MAX_TOKENS', 26),
  discoverMaxWallBps: num('DISCOVER_MAX_WALL_BPS', 45),
  discoverMinLiqUsd: num('DISCOVER_MIN_LIQ_USD', 120_000),
  discoverMinVolUsd: num('DISCOVER_MIN_VOL_USD', 250_000),
  // A Jupiter-poll hit on a token the on-chain engine covers must be backed by a
  // local round trip of at least this (bps) — forensics showed poll-only hits
  // were phantoms from Jupiter's cache. Jupiter can route better than our best
  // pool pair, hence a small negative tolerance rather than 0.
  pollAgreeBps: num('POLL_AGREE_BPS', -3),
  // Build PumpSwap legs locally (src/build.ts) instead of via Jupiter.
  localBuild: bool('LOCAL_BUILD', true),
  // Address lookup table: rent is ~0.00022 SOL per address and it is LOCKED
  // (reclaimable, but not tradeable). A table is also hard-capped at 256
  // addresses. So we buy coverage only for the pools most likely to fire —
  // cheapest-fee pools first — and never spend more than this share of the
  // wallet on it. Set ALT_MAX_ADDRESSES=0 to disable lookup tables entirely.
  altMaxAddresses: num('ALT_MAX_ADDRESSES', 96),
  altMaxWalletShare: num('ALT_MAX_WALLET_SHARE', 0.25),
};

// Safety rail: this is a learning tool. Live trades are capped small so a
// bug or a bad fill costs lunch money, not rent. Raise deliberately or not at all.
if (!CFG.dryRun && CFG.tradeSizeSol > 0.05) {
  throw new Error(
    'Safety rail: TRADE_SIZE_SOL > 0.05 SOL in LIVE mode. ' +
      'Edit src/config.ts yourself if you truly mean it.',
  );
}
