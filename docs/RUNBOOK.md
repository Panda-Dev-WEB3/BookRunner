# Bookrunner — Runbook

## Local devnet (anvil, chain 31337)

```bash
npx -y bun@1.4.2 install          # bootstraps bun + workspace deps
docker compose up -d              # Postgres+Timescale :54400, Redis :63790, anvil :8547
./node_modules/.bin/bun run db:migrate
./node_modules/.bin/bun run deploy:local   # forge script Deploy + LaunchBooks (NVDA, TSLA, RHX5)
./node_modules/.bin/bun run dev            # all services + web on http://127.0.0.1:5180
```

Devnet uses short cadences: marks every `MARK_INTERVAL_SECONDS` (300), receipts roots every
`RECEIPTS_INTERVAL_SECONDS` (60), subscription windows of 10 minutes, Junior notice of 15 minutes,
and `SESSIONS_MODE=24x7` so books quote outside US market hours. Set `SESSIONS_MODE=charter` to see
off-hours holds and reduce-only behaviour.

## Mainnet (Robinhood Chain 4663) — Lane C4, NOT executed from this repo

Preconditions (all must be checked off in `docs/VERIFY.md` with sources):

1. Orderly Vault address/ABI on RHC, accountId derivation, builder IF accounts, builder endpoints,
   symbol naming, fee settlement cadence and the per-symbol IF minimum.
2. Uniswap v3 SwapRouter02 (and v4 UniversalRouter if used) on RHC and the Stock Token pools for each
   hedge asset; EntryPoint v0.7; USDC/USDG addresses; canonical Stock Token addresses + multipliers;
   Chainlink equity feed addresses; Dwellir archive RPC.
3. TEE attestation for the oracle signer verified and the attestation hash registered.

Deployment (fresh deployer, multisig admin, unlinked from other studio deployers):

1. Deploy with `Deploy.s.sol` using `--rpc-url $RHC_RPC_URL` and a hardware/multisig-controlled
   deployer; set the TimelockController min delay to 48h; grant `DEFAULT_ADMIN_ROLE` on
   BookrunnerConfig to the TimelockController, call `config.setAddress("timelock", <controller>)`
   (it must already hold the admin role), transfer every other admin role to the timelock and the
   timelock proposer/executor roles to the multisig; renounce the deployer. Assert afterwards that
   `config.timelock() == <controller>` and the deployer holds no role (`timelock()` resolves to
   `address(0)` — every upgrade/timelock power fails closed — if the recorded address lost the admin
   role).
2. Grant roles: MARK_SIGNER, RISK, OPS_VENUE, JURY, KEEPER to service keys held in a secret manager
   (never the test mnemonic; `devkeys.ts` refuses non-local chains without explicit keys).
3. Register oracle signer(s) with the attestation hash; register Stock Tokens and indices with
   multipliers and float caps; set venue minimum IF per venue; set agent tier bonds.
4. Seat the three committee members; each calls `bond()`.
5. Charter the three launch books (NVDA, TSLA, Stock-Token index) from the studio treasury
   (sponsor), committee approves, subscription windows open at launch, first marks the same day.

## Operations

- **Kill switch for new business**: `BookrunnerConfig.setNewBooksPaused(true)` (GUARDIAN or timelock)
  — pauses new charters, books and deposits. Redemptions keep working; there is no switch for them.
- **Re-mandate after a kill**: committee `proposeAction(bookId, "REMANDATE", abi.encode(mandate))`,
  2-of-3 approve; the sponsor re-registers desk keys.
- **Mark reconciliation break** (Day-30 kill criterion): freeze new charters until clean; compare the
  mark's `pnl_json` venue section against the venue statement for the period.
- **Wind-down**: `MarketCharter.retire(bookId)` → agents flatten → keeper recalls IF + MM → final
  mark with zero deployed value → `finalizeRetirement` → every holder redeems at the final NAV.
