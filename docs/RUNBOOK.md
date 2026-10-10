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
   hedge asset (route, depth: `scripts/check-pools.ts`); EntryPoint v0.7; USDG (settlement token);
   canonical Stock Token addresses + multipliers;
   Chainlink equity feed addresses; Dwellir archive RPC.
3. TEE attestation for the oracle signer verified and the attestation hash registered.

Deployment (fresh deployer, multisig admin, unlinked from other studio deployers):

1. **Not with `Deploy.s.sol`.** That script is devnet (31337) / testnet (46630) only: it refuses any
   other chain id and deploys protocol-owned mocks (USDC, Stock Tokens, MockSwapRouter,
   MockOrderlyVault). Mainnet needs a dedicated script (Lane C4, not in this repo) that performs the
   same wiring (`_deployCore` / `_deployVenuesAndGovernance` / `_registerImplementations` /
   `_grantRoles`) against the VERIFY-ed external addresses, with a hardware/multisig-controlled
   deployer and `--rpc-url $RHC_RPC_URL`. It must keep the governance choices of `Deploy.s.sol`:
   - `StockTokenRegistry` constructed with `admin = address(0)`: it is governed by
     `config.timelock()` only, so the timelock handover below also hands over the registry;
   - `expenseRecipient` (charter fees) and `slashRecipient` (slashed BKRN) set to the treasury
     multisig (`TREASURY_ADDRESS` / `SLASH_RECIPIENT_ADDRESS`), never the deployer key;
   - **settlement token = USDG** (`config.setAddress("usdc", USDG)`, VERIFY S1/O3; the key keeps its
     historical name). `BookrunnerConfig` reverts `BadSettlementToken` unless the token returns
     `decimals() == 6`, so a wrong address or a non-6-decimals token cannot be wired. Every component
     caches it at construction / initialize: set it before deploying BkrnFeeRouter / Backstop /
     PoolEngine and before chartering any book. UIs read its `symbol()` from chain;
   - `BkrnFeeRouter.setBuybackParams(poolFee, refBkrnPerUsdcWad, maxSlippageBps, maxPerCall)` with the
     VERIFY-ed SwapRouter02 BKRN/USDG fee tier, a reference price near market and a per-call cap; then
     choose the reference source: keep REF_FIXED, or `setTwapParams(pool, window, maxTickDeviation)` +
     `setReferenceSource(1)` (Uniswap v3 TWAP of the BKRN/USDG pool; the pool's observation
     cardinality must cover the window — `increaseObservationCardinalityNext` on the pool first, e.g.
     ≥ window / average block spacing of swaps; window 10 min–2 days, deviation ≤ 2,000 ticks), or
     `setBkrnPriceId` (REF_ATTESTED, once the oracle prices BKRN);
   - `HedgeExecutor` with the real SwapRouter02 (`0xcaf6…5cb2`, VERIFY U1), `setV3Factory(UniswapV3Factory)`
     and one `setRoute("UNIV3", stockToken, fee, hop, hopFee)` per hedge asset (direct USDG pool, or a
     two-pool route through WETH). With the factory set, `setRoute` reverts unless every pool exists.
     Agents / risk send `poolFee = 0` (= the route). `UNIV4` stays unset until VERIFY U3 is resolved;
   - run `bun scripts/check-pools.ts` (read-only) against the mainnet deployment file and keep its
     output with the launch record: every active Stock Token must show a route, existing pools with
     liquidity and a round-trip quote within the slippage bound (VERIFY U4), and the buyback pool /
     reference must read without reverting;
   - BKRN allocations minted to the deployer (`community` / `liquidity` / `contributors`) go to
     their multisig / vesting addresses at construction, not to the deployer.
2. Handover: set the TimelockController min delay to 48h; grant `DEFAULT_ADMIN_ROLE` on
   BookrunnerConfig to the TimelockController, call `config.setAddress("timelock", <controller>)`
   (it must already hold the admin role), transfer every other admin role to the timelock and the
   timelock proposer/executor roles to the multisig; renounce the deployer's `GUARDIAN_ROLE` and
   `DEFAULT_ADMIN_ROLE` (grant GUARDIAN to the guardian multisig).

   **Post-conditions** (assert every one on-chain; `timelock()` resolves to `address(0)` — every
   timelock power fails closed — if the recorded address lost the admin role):
   - `config.timelock() == <controller>`; the deployer holds no BookrunnerConfig role
     (DEFAULT_ADMIN, GUARDIAN, MARK_SIGNER, RISK, OPS_VENUE, JURY, KEEPER);
   - `StockTokenRegistry.admin() == address(0)` (if a registry was deployed with an admin, call
     `renounceAdmin()` from it first);
   - `config.expenseRecipient()` and `config.slashRecipient()` are the treasury multisig, not the
     deployer;
   - `config.usdc()` is USDG (`0x5fc5…d168`, decimals 6);
   - `BkrnFeeRouter.buybackRouter()` is the real SwapRouter02 (never MockSwapRouter) and
     `buybackPoolFee()` / `refBkrnPerUsdcWad()` / `maxSlippageBps()` / `maxBuybackPerCall()` are set,
     `referenceSource()` is the intended source and `referenceBkrnPerUsdc()` does not revert;
     `BkrnStaking.cooldown() >= 1 day` and `rewardsDuration()` set;
   - `HedgeExecutor.routerOf("UNIV3")` is the real SwapRouter02, `v3Factory()` is set, and
     `routeOf("UNIV3", token)` is non-zero for every active Stock Token (`check-pools.ts` exits 0);
   - the deployer holds no BKRN allocation and owns no contract (`Ownable` mocks are never deployed).

   Testnet (46630) keeps the deployer as `config.timelock()` (0s delay) on purpose: the post-
   conditions above apply to mainnet only, except that the testnet treasury is devkeys index 22,
   not the deployer.
3. Grant roles: MARK_SIGNER, RISK, OPS_VENUE, JURY, KEEPER to service keys held in a secret manager
   (never the test mnemonic; `devkeys.ts` refuses non-local chains without explicit keys).
4. Register oracle signer(s) with the attestation hash; register Stock Tokens and indices with
   multipliers and float caps; set venue minimum IF per venue; set agent tier bonds.
5. Seat the three committee members; each calls `bond()`.
6. Charter the three launch books (NVDA, TSLA, Stock-Token index) from the studio treasury
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
- **Replacing HedgeExecutor or BkrnFeeRouter** (plain, non-upgradeable contracts resolved through
  `config`): deploy the new contract, configure it (HedgeExecutor: router(s), `setV3Factory`, one
  `setRoute` per hedge asset; BkrnFeeRouter: `setBuybackRouter`, `setBuybackParams`, reference
  source), then `config.setAddress("hedgeExecutor" | "feeRouter", new)` through the timelock.
  Desks resolve `config.hedgeExecutor()` on every swap, RevenueRouters resolve `config.feeRouter()`
  on every distribution and `BkrnStaking.notifyReward` only accepts the current `config.feeRouter()`.
  Before the fee-router repoint executes, drain the old router's `buybackPending` with
  `executeBuyback` (its pending settlement token has no sweep and its buybacks stop working once
  staking points at the new router). Agents / risk must run with `HEDGE_POOL_FEE` /
  `RISK_FLATTEN_POOL_FEE` = 0 (or the route's exact fee) against a route-aware HedgeExecutor.
- **Route review**: `bun scripts/check-pools.ts` (read-only) before every `setRoute` proposal and
  periodically; a failing token (no pool, no liquidity, round trip beyond the bound) should be
  re-routed or removed from mandates' `hedgeAllowRoot` before agents hedge it.
