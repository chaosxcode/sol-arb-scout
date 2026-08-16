// Wrapped SOL mint (native SOL for routing purposes)
export const SOL = 'So11111111111111111111111111111111111111112';

// Scan targets. Majors are the most competed lanes (educational baseline);
// add fresh long-tail mints here — that's where whales haven't indexed yet.
export const TOKENS: Record<string, string> = {
  // Stablecoin round trips (SOL->USDC->SOL) sit at 0-2 bps forever — pure fee
  // drag; they can never clear tip+fees. Kept for reference, not scanned.
  // USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',

  // ---- Selected by FEE WALL (added 2026-08-16) ----
  // What decides whether an edge is capturable is not liquidity or freshness but
  // the sum of the two cheapest venue fees for a round trip. Measured on-chain:
  // these sit at 20-35 bps, vs 75-200 bps for the fresh-memecoin batch below
  // (whose DLMM pools carry 50-200 bps base fees and can essentially never pay).
  PUMP: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',      // wall  20 bps | raydium-clmm(10)+dlmm(10) | $25.6M liq, $20.4M vol
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',     // wall  26 bps | dlmm(10)+orca-wp(16)      | $3.0M liq, $15.6M vol
  TRUMP: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',     // wall  30 bps | orca-wp(5)+raydium-clmm(25)| $31.2M liq
  FARTCOIN: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',  // wall  32 bps | orca-wp(16)+orca-wp(16)   | $5.3M liq
  MET: 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL',        // wall  35 bps | dlmm(15)+dlmm(20)         | $1.8M liq

  // ---- Fresh long-tail (added 2026-08-15) ----
  // Sourced from Jupiter Tokens v2 recent/trending lists, filtered for
  // mint+freeze authority disabled, real liquidity, high 24h turnover, and
  // verified to round-trip via Jupiter at 0.02 SOL. Round-trip edge on the
  // day added is noted; expect these to age out — re-run the screen monthly.
  XST: 'XSTuo1fV7HHMhs4BYiwtrWSLsMCJNrooH2AssWTYZqP',   // 22d, $310k liq, -19 bps
  STONK: '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx', // 22d, $678k liq, -36 bps
  TOAD: 'A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump',  //  6d, $785k liq,  -6 bps (Token-2022, pump.fun grad)
  CATE: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump',  // 19d, $1.1M liq, -57 bps (Token-2022, pump.fun grad)
  KET: '9Pfync3ejPC9eHqVzq3nYQJAhyhjqpnB9UsaSfLxpump',   // 38d, $225k liq, -79 bps
  // MANLET retired 2026-08-16: fee wall measured at 200 bps (two 100-bps DLMM
  // pools) — the round trip cannot pay unless the spread exceeds 2%, which is
  // rarer than the subscription is worth.
  // MANLET: 'HxQhDGYqyjorgogMJx7YbBHADEDxuHhLnMMmr6VYpyn',
};
