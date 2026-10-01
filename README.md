# Bookrunner ($BKRN)

**Run the book.** The underwriting syndicate for on-chain perp markets.

Capital allocators subscribe to tranches of a *book*; the book capitalises one market's insurance
fund and market-making inventory; bookrunner agents quote and hedge it under a mandate letter
enforced in code; the book earns the market's fee flow. Stock perps first, on Robinhood Chain.

- **Charter a market** — a sponsor files a `MarketCharter` (underlying, venue, oracle plan, sessions,
  insurance-fund size, MM mandate, tranche terms). The Risk Committee — a model-jury verdict plus
  three bonded members — approves or rejects within 48h. Approved charters become books.
- **Subscribe to the book** — two tranches per book:
  - **Senior**: first claim on fee flow up to its share, last loss in the waterfall; redeemable at
    NAV at every mark.
  - **Junior**: residual fee flow, first loss; redeemable at NAV after notice (notice is not a gate).
  Allocation is pro-rata with a per-wallet cap; the sponsor holds at least 10% of Junior.
- **Capitalise the market** — insurance fund and MM inventory deployed to the venue (a builder
  market listed on Orderly's public contracts, or the in-house pool-vs-trader engine).
- **Agent bookrunners quote it** — under an `MMMandate`: width, skew, inventory, hedge band,
  off-hours rule, drawdown kill. On-chain legs are validated in code; venue quoting is monitored
  and keys are revoked on breach.
- **Earn the fee flow** — `RevenueRouter` runs the waterfall: expenses → protocol carry (10%) →
  Senior share → Junior residual. Losses run the other way: Junior → Senior → backstop up to the
  pool. Every book publishes NAV, inventory, P&L and limit utilisation; each mark is a signed,
  receipt-rooted statement.

Bookrunner is software; not a fund, adviser, broker or venue operator of record. Stock-perp books
are not offered to US persons.

## Repository

| Path | What |
|---|---|
| `contracts/` | Foundry: MarketCharter, RiskCommittee, BookFactory, Book (UUPS), Tranche ×2 (ERC-4626 / ERC-7540-style), UnderwritingVault, MMMandate, BookrunnerDesk (ERC-4337), RevenueRouter, MarkRegistry, Backstop, BkrnFeeRouter, BkrnStaking, BkrnToken, AttestedOracle, PoolEngine, venue adapters |
| `packages/shared` | Types, units, waterfall + mandate math (normative), sessions codec, EIP-712, Merkle receipts, ABIs |
| `packages/db` | Drizzle schema, migrations, Timescale hypertables |
| `services/*` | oracle, ops-venue, mock-orderly, bookrunner-agent, risk, mark, waterfall, receipts, charter, indexer, api |
| `apps/web` | Book dashboards: NAV, limits, marks, fills, charters, committee |
| `docs/` | `ARCHITECTURE.md` (build contract), `BOUNTY_SCOPE.md`, `RUNBOOK.md`, `VERIFY.md` |

## Quick start (local devnet)

```bash
npx -y bun@1.4.2 install
docker compose up -d
./node_modules/.bin/bun run db:migrate
./node_modules/.bin/bun run deploy:local
./node_modules/.bin/bun run dev
```

Foundry runs through Docker (`bash scripts/forge.sh build|test`) — see `docs/RUNBOOK.md`.

Stack: Bun · Hono · tRPC v11 · Drizzle · Postgres + Timescale · Redis + BullMQ · viem · Foundry ·
ERC-4337 session keys.
