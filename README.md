# sol-arb-scout

A Solana round-trip arbitrage scanner + Jito bundle executor. Built as a
learning tool: it finds SOL → token → SOL edges via Jupiter routing (which
already spans multiple DEX pools — Jupiter's route *is* the triangle) and,
in live mode, submits both legs plus a tip as one atomic Jito bundle.

**Honest expectations:** free-tier RPC is ~200ms behind colocated bots, and
winners pay 50–70% of profit in tips. Expected profit ≈ $0. Expected
learning ≈ high. Failed bundles cost nothing; that's the safe part.

## Quickstart (Linux)

Needs Node 20+ (`node --version`). If missing: install via nvm or your
package manager.

```bash
unzip sol-arb-scout.zip && cd sol-arb-scout
npm install
cp .env.example .env    # optionally paste a free Helius/QuickNode RPC
npm start               # DRY RUN — scans and logs edges, trades nothing
```

Let it run 15–30 min. You'll mostly see negative edges (that's fees +
routing cost). Watching how rarely anything crosses +25 bps, and how fast
it vanishes, is the actual education.

## Going live (optional, burner money only)

```bash
npm run wallet          # creates wallet.json, prints pubkey
# send it $5-10 of SOL, no more
```

Then in `.env`: set `DRY_RUN=false`. There's a hard safety rail refusing
trade sizes over 0.05 SOL in live mode.

## Config knobs (.env)

| Key | Meaning |
|---|---|
| `TRADE_SIZE_SOL` | Round-trip size (default 0.02) |
| `MIN_PROFIT_BPS` | Execute/log threshold (default 25) |
| `SLIPPAGE_BPS` | Per-leg slippage tolerance |
| `JITO_TIP_LAMPORTS` | Flat tip; competitive bundles bid % of profit |
| `USE_JITO` | `false` = non-atomic raw sends (not recommended) |

## Things that will drift

APIs move. If quotes 404, update `JUP_BASE` (check dev.jup.ag). If bundles
reject, verify the block engine URL and tip accounts against Jito's docs.
All of it is `.env`/one-file fixes — the strategy code doesn't change.

## Where the real edge would be

Not in this file. It's in: fresh long-tail pools (add mints to
`src/tokens.ts`), Geyser gRPC feeds instead of polling, Rust instead of
TypeScript, and a server physically near validators. Each of those is a
deliberate next step, not a weekend.

## Safety notes

- `wallet.json` and `.env` are gitignored. Never share or commit them.
- Only fund the burner with money you're fine losing to gas and tips.
- Nothing here is financial advice; it's an engineering classroom.
