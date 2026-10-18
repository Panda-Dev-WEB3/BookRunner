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

## Mainnet (Robinhood Chain 4663) — operator checklist

Tools: [`contracts/script/DeployMainnet.s.sol`](../contracts/script/DeployMainnet.s.sol) (deploy + wiring +
governance handover in one broadcast, no mocks), [`contracts/script/VerifyHandover.s.sol`](../contracts/script/VerifyHandover.s.sol)
(read-only PASS/FAIL table of every post-condition below), both driven by
[`scripts/deploy-mainnet.sh`](../scripts/deploy-mainnet.sh) and one JSON input
([`contracts/deploy-inputs/`](../contracts/deploy-inputs/README.md)). Services: `scripts/dev.ts --network mainnet`
on a separate host ([deploy/server/MAINNET.md](../deploy/server/MAINNET.md)). `Deploy.s.sol` is devnet/testnet
only (it deploys mocks and refuses 4663). Tick every box in order; two people for every step marked (2P).

### A. Preconditions (all blocking)

- [ ] `docs/VERIFY.md`: every row the input uses is **Confirmed** and re-checked on-chain: O2 vault, O3/S1
      USDG (6 decimals), O7 broker / token hash, U1 SwapRouter02, A1 EntryPoint, T3 Stock Tokens, C4 feeds.
- [ ] VERIFY O6 (Orderly accountId) and O9 (withdraw receiver): done in OrderlyAdapter v3 (MM = the adapter's
      own account, IF = the per-book `OrderlyIFAccount`). Remaining (VERIFY O10): Orderly confirms that the
      book's OrderlyIFAccount (a contract / delegate account) can be assigned as the symbol's IF account. Until
      then do not charter Orderly books (PoolEngine books are unaffected).
- [ ] Uniswap v3 SwapRouter02 / factory / QuoterV2 on RHC and the Stock Token pools for each hedge asset (route,
      depth: `scripts/check-pools.ts`, VERIFY U1-U5); USDG (settlement token).
- [ ] VERIFY C2: `source-check` green against a mainnet RPC ("Real prices" below): the oracle publishes
      per-share prices (Chainlink RHC feeds are per token, multiplier included).
- [ ] VERIFY E1: TEE platform chosen, oracle signer attestation verified ("Oracle signer attestation" below),
      attestation digest of each oracle signer known (input `oracle.signers`).
- [ ] Orderly builder onboarding done: broker id, IF accounts, builder key (MAINNET.md §3).
- [ ] Safe multisig deployed on RHC (owners, threshold agreed); guardian and treasury addresses decided;
      BKRN allocation recipients (community / studio / liquidity / contributors: Safe or vesting contracts).
- [ ] KMS keys created, one per service role, and their addresses printed (MAINNET.md §2).
- [ ] Services host prepared (MAINNET.md §1, §3) — not started.

### B. Input and rehearsal

1. [ ] (2P) `cp contracts/deploy-inputs/4663.example.json contracts/deploy-inputs/4663.json` and fill every
       placeholder (schema + sources: `contracts/deploy-inputs/README.md`). Public addresses only. A second
       person checks each address byte-for-byte against VERIFY / the Safe UI / the KMS output. Commit the input.
2. [ ] Rehearsal on testnet (same code path, real testnet externals): `contracts/deploy-inputs/46630.json` with
       `"network": "rehearsal"`, `"chainId": 46630` and the testnet externals (Orderly testnet vault, testnet
       USDG, a test Safe), then
       ```bash
       REHEARSAL=1 bash scripts/deploy-mainnet.sh simulate
       REHEARSAL=1 bash scripts/deploy-mainnet.sh broadcast      # record: contracts/deployments/46630.rehearsal.json
       REHEARSAL=1 bash scripts/deploy-mainnet.sh verify
       ```
       and charter one book on it (section D) to exercise the launch path end to end.

### C. Deploy + handover

3. [ ] Fresh deployer: `cast wallet new` on a clean machine; put its address in `deployer`; fund it from the
       treasury with enough ETH for ~40 transactions (the simulation prints the estimate). Nothing else ever
       uses this key.
4. [ ] Simulate (sends nothing; validates the input, checks code / decimals / the vault's token on-chain,
       simulates every transaction, writes `contracts/deployments/4663.simulation.json`):
       ```bash
       RHC_RPC_URL=<archive rpc> bash scripts/deploy-mainnet.sh simulate
       ```
       Any `input:` / `externals:` revert is a blocker: fix the input, never the script's checks.
5. [ ] (2P) Broadcast (prompts for chain id confirmation, then the deployer key once — `--interactive` default;
       pass `--ledger` / `--account <keystore>` instead on a native forge):
       ```bash
       RHC_RPC_URL=<archive rpc> bash scripts/deploy-mainnet.sh broadcast
       ```
       It deploys the TimelockController (min delay 48h, proposer = executor = canceller = multisig, no admin)
       and every component (Book linked to BookLogic, OrderlyAdapter v3 with the input's broker / token hashes),
       sets params / HedgeExecutor v3 factory + one route per Stock Token / buyback params + reference source /
       oracle measurements + attested signers + `requireAttestations()` / Stock Tokens (live `uiMultiplier`
       mode, anchors) / indexes / implementations / staking / backstop, grants the service roles to the
       input's addresses and GUARDIAN to the guardian,
       hands `DEFAULT_ADMIN_ROLE` to the timelock, points `config.timelock()` at it and renounces the deployer;
       then fixes `startBlock` from the receipts and runs VerifyHandover. Output: `contracts/deployments/4663.json`.
6. [ ] (2P) Independent check from a second machine and RPC: `bash scripts/deploy-mainnet.sh verify`. Every row
       must PASS. Post-conditions asserted:
       - `config.timelock() == TimelockController`; the controller holds config `DEFAULT_ADMIN_ROLE`; the
         deployer holds **no** role on the config (DEFAULT_ADMIN, GUARDIAN, MARK_SIGNER, RISK, OPS_VENUE, JURY,
         KEEPER) nor on the timelock, no BKRN, and is no oracle signer;
       - timelock: delay == input (>= 48h), PROPOSER / EXECUTOR / CANCELLER = multisig, self-administered,
         multisig not admin, no open executor;
       - `StockTokenRegistry.admin() == 0` (follows `config.timelock()`);
       - `expenseRecipient` / `slashRecipient` == treasury (input), never the deployer;
       - service roles + GUARDIAN as input; committee seats as input; charter + committee are staking lockers;
       - every component reads this config; `config.usdc()` is the 6-decimal settlement token; vault /
         EntryPoint as input; all 8 factory implementations set; the Book implementation is linked to a
         deployed BookLogic; the OrderlyAdapter implementation is v3 (OrderlyIFAccount IF accounts, 6-dp
         settlement) with hashes == input;
       - params, tiers, venue minimum IF (> 25,000e6 for Orderly), staking cooldown (>= 1 day) / rewards
         duration, backstop cap, buyback router (SwapRouter02) + params + reference source (+ TWAP params;
         `referenceBkrnPerUsdc()` reads for fixed / TWAP), HedgeExecutor routers + v3 factory + one route per
         Stock Token, oracle measurements / attested signers (`attestationOf` == the digest) / minSources /
         `attestationRequired`, Stock Tokens (multiplier source, next anchors, band; every multiplier reads) +
         indexes all equal to the input; input Stock Tokens / feeds == `config/chains/4663.json` (the oracle's
         chain price config).
7. [ ] Sweep the deployer's leftover ETH back to the treasury; destroy the key. Archive `4663.json` + the input
       + `contracts/broadcast/DeployMainnet.s.sol/4663/run-latest.json` (the record is gitignored because the
       services host appends books to it). Verify sources on the explorer (VERIFY R2).

### D. Services, committee, launch books, first marks

8. [ ] Services host: copy `4663.json`, fill `/etc/bookrunner/mainnet.env` (one signer per role, real oracle
       sources), fund each role address with gas ETH, `systemctl enable --now bookrunner@mainnet`
       (MAINNET.md §4). The log must show every service started and no "lacks ... role" warning; a refusal lists
       every missing item.
9. [ ] Committee: each of the three members stakes `committeeBondBkrn` in BkrnStaking and calls
       `RiskCommittee.bond()` (sequence as in `scripts/launch-devnet.ts` `fundParticipants`).
10. [ ] Agent operator stakes for its inventory tier (`config.agentTierBond`).
11. [ ] Charter the three launch books (NVDA, TSLA on Orderly; the RHX5 index on the PoolEngine) from the studio
        treasury (sponsor): approve `charterFeeUsd` USDG to MarketCharter, stake `sponsorBondBkrn`, then
        `MarketCharter.file(charter)` per book (`ifTargetUsd >= venueMinIf`, i.e. > 25,000 USDG on Orderly;
        `symbol` = `PERP_<TICKER>_USDC`; field layout as in `scripts/launch-devnet.ts`). The jury posts its
        verdict, two committee members vote, the factory creates the book on finalize.
12. [ ] Record the books: `scripts/record-books.ts` (MAINNET.md §4, `--dry-run` first); dev.ts starts one agent
        per book. Archive the updated `4663.json`.
13. [ ] Per Orderly book, through the timelock (48h, schedule early): `OrderlyAdapter.setDelegateSigner(<ops-venue
        address>)`; pre-fund the adapter with ETH for Orderly deposit fees (VERIFY O5). Desk key per book: the
        operator `consentKey`, the sponsor `registerKey`; put `DESK_KEY_PRIVATE_KEY_<bookId>` in the env file and
        restart `bookrunner@mainnet`.
14. [ ] Subscription windows open at launch; the keeper (waterfall service) closes them at
        `subscriptionEnds`; ops-venue deploys IF + MM to the venue.
15. [ ] First marks: daily (`markInterval` 86400, MARK_INTERVAL_SECONDS 86400). The first mark lands after the
        first full period following the window close: check `MarkRegistry` events and the API, then reconcile
        the mark's venue section against the Orderly statement (`GET /v1/broker/daily_fee_revenue`, VERIFY O11).

### Mainnet wiring reference (what DeployMainnet sets from the input; asserted by VerifyHandover)

`Deploy.s.sol` is devnet (31337) / testnet (46630) only: it refuses any other chain id and deploys
protocol-owned mocks (USDC, Stock Tokens, MockSwapRouter, MockOrderlyVault). `DeployMainnet.s.sol` performs
the same wiring against the VERIFY-ed external addresses of the input and keeps its governance choices:
- `StockTokenRegistry` constructed with `admin = address(0)`: it is governed by `config.timelock()` only, so
  the timelock handover also hands over the registry;
- `expenseRecipient` (charter fees) and `slashRecipient` (slashed BKRN) set to the treasury multisig, never
  the deployer key;
- **settlement token = USDG** (`config.setAddress("usdc", USDG)`, VERIFY S1/O3; the key keeps its historical
  name). `BookrunnerConfig` reverts `BadSettlementToken` unless the token returns `decimals() == 6`, so a
  wrong address or a non-6-decimals token cannot be wired. Every component caches it at construction /
  initialize: it is set before BkrnFeeRouter / Backstop / PoolEngine are deployed and before any book is
  chartered. UIs read its `symbol()` from chain;
- `BkrnFeeRouter.setBuybackParams(poolFee, refBkrnPerUsdcWad, maxSlippageBps, maxPerCall)` with the VERIFY-ed
  SwapRouter02 BKRN/USDG fee tier, a reference price near market and a per-call cap; then the reference
  source: REF_FIXED, or `setTwapParams(pool, window, maxTickDeviation)` + `setReferenceSource(1)` (Uniswap v3
  TWAP of the BKRN/USDG pool; the pool's observation cardinality must cover the window —
  `increaseObservationCardinalityNext` on the pool first, e.g. >= window / average block spacing of swaps;
  window 10 min–2 days, deviation <= 2,000 ticks), or `setBkrnPriceId` (REF_ATTESTED, once the oracle prices
  BKRN);
- `HedgeExecutor` with the real SwapRouter02 (`0xcaf6…5cb2`, VERIFY U1), `setV3Factory(UniswapV3Factory)` and
  one `setRoute("UNIV3", stockToken, fee, hop, hopFee)` per hedge asset (direct USDG pool, or a two-pool route
  through WETH). With the factory set, `setRoute` reverts unless every pool exists. Agents / risk send
  `poolFee = 0` (= the route). `UNIV4` stays unset until VERIFY U3 is resolved;
- after the deploy, `bun scripts/check-pools.ts` (read-only) against the record, output kept with the launch record:
  every active Stock Token must show a route, existing pools with liquidity and a round-trip quote within the
  slippage bound (VERIFY U4), and the buyback pool / reference must read without reverting;
- Stock Tokens registered with their current `uiMultiplier()` as anchor and `setMultiplierSource(token, true)`
  ("Real prices" below; input `stockTokens[].multiplierSource = uiMultiplier`, optional
  `nextMultiplierAnchorWad`); oracle signers through the attestation flow ("Oracle signer attestation" below:
  input `oracle.measurements` + `oracle.signers[]` `{platform, measurement, quoteHash}`, then
  `requireAttestations()`, so steps 4-5 of that flow happen inside the deployment, before the handover);
- the OrderlyAdapter implementation takes only the broker / token hashes; each book proxy deploys its own
  `OrderlyIFAccount` at initialize (VERIFY O6/O9); `venueMinIf[Orderly]` > 25,000e6 (VERIFY O10);
- `Book` links the external library `BookLogic`: forge deploys it as the first transaction of the broadcast
  (through the deterministic CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` when that factory has
  code on the chain, else a plain CREATE from the deployer — checked on a local anvil, Foundry's fallback), so
  the deployer's ETH estimate includes it; the record lists `contracts.bookLogic` and VerifyHandover checks the
  link. `UpgradeBook.s.sol` (existing books) does the same;
- BKRN allocations (`community` / `liquidity` / `contributors`) go to their multisig / vesting addresses at
  construction, not to the deployer.

Post-conditions beyond section C step 6: `config.usdc()` is USDG (`0x5fc5…d168`, decimals 6);
`BkrnFeeRouter.buybackRouter()` is the real SwapRouter02 (never MockSwapRouter), `referenceSource()` is the
intended source and `referenceBkrnPerUsdc()` does not revert; `HedgeExecutor.routerOf("UNIV3")` is the real
SwapRouter02, `v3Factory()` is set and `routeOf("UNIV3", token)` is non-zero for every active Stock Token
(`check-pools.ts` exits 0); the deployer holds no BKRN allocation and owns no contract (`Ownable` mocks are
never deployed).

Testnet (46630) keeps the deployer as `config.timelock()` (0s delay) on purpose: the post-conditions apply to
mainnet only, except that the testnet treasury is devkeys index 22, not the deployer.

### Governance after the handover

Every admin action is a multisig proposal to the TimelockController, executable after 48h:
```bash
DATA=$(cast calldata "setParam(bytes32,uint256)" $(cast --format-bytes32-string carryBps) 900)
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000   # predecessor: none
# Safe transaction to the controller: schedule ...
cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" <config> 0 $DATA $ZERO <salt> 172800
# ... and after 48h execute (same target / value / data / predecessor / salt, no delay):
cast calldata "execute(address,uint256,bytes,bytes32,bytes32)" <config> 0 $DATA $ZERO <salt>
```
`UpgradeOrderlyAdapters.s.sol` broadcasts directly as the timelock (testnet, where the deployer is the
timelock); on mainnet deploy the new implementation from any key and put `setImplementations` + each
`upgradeToAndCall` into one timelock batch (`scheduleBatch` / `executeBatch`).

### Real prices (VERIFY T2-T4, C1-C6)

Units: AttestedOracle prices are USD per **share**; a Robinhood Chainlink feed quotes per **token**
(share price × `uiMultiplier()`); the registry multiplies once by the token's live `uiMultiplier()`.
The oracle divides per-token feeds by that same on-chain value, and the DEX confirm source divides the Stock
Token / USDG price the same way (`packages/shared/src/stockTokens.ts`). Never configure an HTTP source that quotes
the Stock Token price: every HTTP / Pyth source must be a per-share US-equity price.

Mainnet runs the **primary + confirm** policy (`ORACLE_POLICY=primary-confirm`, VERIFY C6; devnet / testnet keep
`median`):

- **Chainlink alone sets and signs each price** (`sourceCount` 1, `ORACLE_MIN_SOURCES=1`, on-chain
  `AttestedOracle.minSources() == 1`; the oracle refuses to start otherwise).
- **A Uniswap v3 TWAP confirms it**: per ticker the deepest Stock Token / USDG pool of `config/chains/4663.json`
  `dexConfirm.pools` (1800 s window; 2% depth floor `minDepthUsd` $25,000 = USDG needed to move the pool price 2%
  within the active range; each pool checked against the v3 factory's `getPool(stockToken, USDG, fee)`). Pyth Pro
  (`ORACLE_PYTH=1` + `PYTH_API_KEY`) and `ORACLE_HTTP_SOURCES` are optional extra confirmers; none of them ever
  counts for signing. `sourcesHash` commits to Chainlink and every fresh confirmer.
- **Depth today** (read 2026-10-18): NVDA ~$314k, TSLA ~$45.5k, AAPL ~$61.8k, MSFT ~$43.7k, AMZN ~$83.2k: all above
  the floor. Why $25k and 1800 s (controller decision 2026-10-18): recalibrated from the earlier balance-based
  $50k (the 2% depth measure is 2–5x stricter than the pool's USDG balance); the DEX only confirms, so a thin pool
  can only cause false or missing alerts, never a price change; 1800 s keeps a swap inside the window in quiet hours.
- **Quiet hours**: a pool with no swap inside the TWAP window is `unavailable` ("no swap in the 1800s TWAP
  window"; `source-check` prints "last swap Ns ago"). On 2026-10-18 (a Sunday) the last swaps were 92–1,696 s old
  and TSLA had none for 8,909 s: expect intermittent `unavailable` off-peak; the alert needs 10 min continuous.
- **The DEX never moves the price.** A confirmer more than `ORACLE_CONFIRM_BPS` (200 bps) from Chainlink: Chainlink
  is still published, the oracle warns (rate-limited) and `/health` `confirm[]` shows the ticker `diverged`.
- **"Chainlink stale" = no fresh price** for that ticker (the DEX never substitutes) only when the read fails, the
  token is `oraclePaused()`, the sequencer check fails, or the round is older than heartbeat + grace in session
  (24 h 10 min with the defaults; mainnet refuses more than heartbeat + 1 h). Once the last signed price is older
  than `maxPriceAge` (300 s) on-chain, `priceOf` reverts `StalePrice`: valuations, trades on that key **and
  liquidations** revert until Chainlink is back (reduce-only applies only to `held` prices, i.e. off-hours).
  Off-hours prices hold at the last Chainlink price; a start off-hours without history seeds from Chainlink only.
- **A stalled feed is signed as fresh.** A feed that silently stops updating but keeps answering is signed as a
  fresh, non-held price for up to heartbeat + grace (24 h 10 min). The feeds round on a 0.5% (50 bps) deviation or
  the 24 h heartbeat and normal in-session gaps reach ~15–22 h, so age alone cannot tell a quiet market from a
  stalled feed. The signal is the confirm gap: above `ORACLE_PRIMARY_LAG_BPS` (100) with no new round since it
  began → `oracle_primary_suspect_stale`; above `ORACLE_CONFIRM_BPS` (200) → `oracle_confirm_divergence`.
- **Health**: `GET /health` `sources[]` (role `primary` / `confirm`, `lastOkAt`, `failingSince`,
  `failingTickers`, `lastError`; in-session tickers only), `confirm[]` (per ticker `status` ok / diverged /
  unavailable / no-primary / closed (off-hours, not evaluated), sticky; `current` = this tick's raw status;
  `diffBps`, `since`, `primaryPrice`, `primaryTs` (the Chainlink round's `updatedAt`), `lagSince` (start of the
  run with a gap above `primaryLagBps`), confirmers), top-level `confirmBps` / `primaryLagBps`, `unpublished[]`
  (in-session tickers without a publishable price). Runs (diverged / unavailable, lag, source failure,
  unpublished) end only after the other state held `ORACLE_CONFIRM_HYSTERESIS_MS` (60 s): a one-tick flap does
  not reset the alert timers.
- **Calendar.** Holiday eves after 20:00 ET (incl. the Sunday before a Monday holiday) and early-close days after
  17:00 ET are closed in the 24/5 calendar (`NYSE_EARLY_CLOSES`, holiday-eve rule in
  `packages/shared/src/sessions.ts`), so prices are **held** there (VERIFY C3).

Alerts (`services/alerts`) and what to do:

- **`oracle_source_failing:chainlink`** (critical, > 60 s in session, `ALERT_ORACLE_SOURCE_FAIL_SECONDS`): no price
  for the listed tickers. `sources[].lastError` gives the cause: RPC errors → check `ORACLE_CHAINLINK_RPC_URL`
  (or point it at another RHC RPC), restart `bookrunner@mainnet`; `oraclePaused()` → corporate action (below); a
  round older than heartbeat + grace in session → Chainlink status / support, `source-check`. Nothing substitutes:
  if it lasts beyond `maxPriceAge`, pause new business (GUARDIAN `setNewBooksPaused(true)`, "Rollback and
  incidents"). **Sunday open**: the first round after 20:00 ET can land tens of seconds late (seen ~24 s); a
  slower one pages this alert and prices skip until it lands. Expected; do **not** widen
  `ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS` to silence it (mainnet refuses more than 1 h, and a wider grace signs an
  old round as fresh).
- **`oracle_price_missing:<id>`** (critical, 2 min, `ALERT_ORACLE_PRICE_MISSING_SECONDS`): an in-session ticker
  without a publishable price that no Chainlink alert explains: `/health` `unpublished[].reason` and the oracle log.
- **`oracle_primary_suspect_stale:<id>`** (warning; the confirm gap above `ORACLE_PRIMARY_LAG_BPS` (100) for
  `ALERT_ORACLE_PRIMARY_LAG_SECONDS` (600) in session **and** no new Chainlink round for that long: the clock runs
  from the later of `lagSince` and `primaryTs`, so a round mid-gap restarts it rather than silencing it; the oracle
  logs "Chainlink suspect stale" after 10 min): the feed may have stopped updating while it
  keeps answering, and it is still signed as fresh until heartbeat + grace (~24 h). A live feed 50 bps off the
  market would have rounded by now. Same checks and levers as divergence (below).
- **`oracle_confirm_divergence:<id>`** (warning after 2 min above `ORACLE_CONFIRM_BPS` (200) in session,
  `ALERT_ORACLE_CONFIRM_DIVERGENCE_SECONDS`; critical above 2× the threshold (400 bps) or with ≥ 3 tickers at once,
  `ALERT_ORACLE_CONFIRM_CRITICAL_TICKERS`). The published price is still Chainlink. Find which side is wrong (the
  code cannot tell them apart):
  1. Chainlink: the feed's `latestRoundData()` `updatedAt` and answer on-chain (`source-check`, `/health`
     `confirm[].primaryTs`) vs the market; Chainlink status and Robinhood status. A round hours old while other
     venues moved more than 50 bps means the feed is stalled or lagging;
  2. the DEX pool: spot vs TWAP (`source-check` `dex confirm` row prints both), 2% depth vs floor, last swap age,
     recent large swaps on the explorer;
  3. the USDG peg: every ticker diverging in the same direction at once points at USDG, not the equities;
  4. other markets: the underlying's public quote (regular, pre, post or overnight session).

  Chainlink is the one that is wrong (stalled or lagging): the RHX5 PoolEngine fills at that price (an arbitrage
  window against the pool); stop new risk on the RHX5 book with the existing levers — risk kill on the book
  (reduce-only) or GUARDIAN `setNewBooksPaused(true)` ("Rollback and incidents") — until Chainlink rounds again.
  The oracle itself never switches source. At launch RHX5 is off or on small caps (owner decision, VERIFY C6).
  DEX manipulated or thin: nothing to do for prices (the DEX never moves them); if a pool is easy to move, raise
  its `minDepthUsd` or choose a deeper pool / fee tier in `config/chains/4663.json`, then restart. USDG depeg:
  prices are unaffected (Chainlink quotes USD); the alerts last until the peg recovers; assess the USDG exposure of
  the books separately (VERIFY S1).
- **`oracle_confirm_unavailable:<id>`** (warning, no confirm source for 10 min continuous in session, with the
  60 s hysteresis, `ALERT_ORACLE_CONFIRM_UNAVAILABLE_SECONDS`; the oracle logs it after
  `ORACLE_CONFIRM_UNAVAILABLE_WARN_MS`): Chainlink is published unconfirmed. Causes (`source-check` prints the
  reason per ticker): 2% depth below `minDepthUsd`, no swap inside the TWAP window (quiet
  hours), observation history shorter than the window, the pool not the factory's `getPool`, token
  `oraclePaused()` or a multiplier change inside the window, the DEX RPC (`ORACLE_DEX_RPC_URL`, default
  `ORACLE_CHAINLINK_RPC_URL`), a block older than `ORACLE_DEX_MAX_AGE_MS`. A pool that stays below its floor:
  switch to a deeper pool / tier (`dexConfirm.pools`) if one exists; never lower the floor (and never below
  10,000). While a ticker has no confirm, `oracle_primary_suspect_stale` cannot fire for it either: watch its
  Chainlink round age by hand.
- **`oracle_source_failing:<confirm source>`** (warning, after 10 min; not for tickers already `unavailable` or
  without Chainlink): one confirmer fails while others still confirm, e.g. Pyth Pro HTTP 401 / 403 → renew the token
  in the Pyth Pro dashboard, update `PYTH_API_KEY` in `/etc/bookrunner/mainnet.env`, restart; 429 / 5xx / timeout →
  Pyth status page. Prices continue from Chainlink.
- **`oracle_min_sources`** (critical): `AttestedOracle.minSources()` is no longer 1: every price is refused
  on-chain; restore it through the timelock (`setMinSources(1)`).

Residual risks of the design (VERIFY C6): (a) Chainlink is a single point of failure: a pause
(`oraclePaused()`, corporate action), a feed outage or a split / multiplier change mid-round leaves that ticker
without a fresh price (hold off-hours, skip in session, `StalePrice` after `maxPriceAge`), and a feed that stops
updating but keeps answering is signed as fresh for up to heartbeat + grace (24 h 10 min), caught only by the
suspect-stale / divergence alerts; (b) the 0.5% deviation / 24 h heartbeat rule lets the signed price trail the
market by up to ~50 bps in session without a new round (more in a fast move) and RHX5 trades on it: RHX5 off or
small `maxNetExposureUsd` caps at launch (owner decision) until the lag has been observed; (c) USDG is assumed =
$1: a depeg shows up as divergence alerts on every ticker, not as a price change; (d) DEX manipulation only raises
alerts; a pool below its 2% depth floor or without a swap in the window gives no confirmation (alert after 10 min);
(e) a stalled / lagging Chainlink and a manipulated DEX look the same to the code: the operator decides (steps
above).

**Corporate action** (Chainlink `oraclePaused()` on a token): that ticker has **no price** for the paused window —
held off-hours, skipped in session (then `StalePrice` after `maxPriceAge`); its DEX confirm stops too. Plan it with
the corporate-actions steps below.

1. **Source check** (read-only, before anything is registered and again right before launch):
   `bun run --cwd services/oracle source-check --chain 4663 --rpc $RHC_RPC_URL [--registry 0x<registry>]`
   reads every feed and token in `config/chains/4663.json` (proxy code, `decimals()`, `description()`,
   `latestRoundData()` age vs heartbeat in session, token code / `decimals() == 18` / `uiMultiplier()` /
   `oraclePaused()` / pending multiplier, per-share price), per ticker the `dex confirm` row (TWAP per share vs
   Chainlink per share, diff in bps, 2% depth vs floor, cardinality, observation history, "last swap Ns ago",
   "factory getPool verified"; FAIL on 4663 when a pool is missing, not the factory's, below its depth floor, too
   young for the window or unreadable (2026-10-18: none); WARN on transient causes (no swap
   in the window, token paused, multiplier change in the window) and above `ORACLE_CONFIRM_BPS`), the
   optional confirmers (Pyth Pro when `PYTH_API_KEY` is set, `ORACLE_HTTP_SOURCES`: WARN only), the summary rows
   `sources primary` / `sources confirm`, the `pyth calendar` row (WARN), the mainnet production rules of the
   current `ORACLE_*` environment, and with `--registry` the registration + live-multiplier mode. Exit code 1 on
   any FAIL; fix every FAIL. Off the mainnet host, a Pyth token stays in the gitignored `.env.pyth`:
   `cd services/oracle && bun --env-file=../../.env.pyth src/cli/source-check.ts --chain 4663 --rpc ...`.
2. **Stock Tokens** (timelock, per token of `config/chains/4663.json`):
   `register(token, bytes32(<TICKER>), <current uiMultiplier()>, floatCapRaw)` then
   `setMultiplierSource(token, true)`. The stored value is the anchor; the live multiplier may drift
   `multiplierBandBps` (default 500 = 5%) from it before valuations fail closed.
3. **Oracle environment** (`services/oracle`, chain 4663): `ORACLE_SYNTHETIC=0`, `SESSIONS_MODE=charter`,
   `ORACLE_POLICY=primary-confirm` and `ORACLE_MIN_SOURCES=1` (both pinned by the mainnet profile,
   `scripts/network-profile.ts`; a contradicting inherited value is refused; the service also requires
   `AttestedOracle.minSources() == 1`, set by DeployMainnet from `params.oracleMinSources`), `ORACLE_CONFIRM_BPS`
   (default 200, at most 500), `ORACLE_PRIMARY_LAG_BPS` (default 100, below `ORACLE_CONFIRM_BPS`),
   `ORACLE_CONFIRM_HYSTERESIS_MS` (default 60 s), the DEX confirm (`ORACLE_DEX_CONFIRM` default 1, cannot be 0 on
   4663; `ORACLE_DEX_TWAP_SEC` overrides the pools' 1800 s, 300–3600 s on 4663; `ORACLE_DEX_MAX_AGE_MS` 60 s, at most
   120 s on 4663; `ORACLE_DEX_RPC_URL`, default `ORACLE_CHAINLINK_RPC_URL`, else `RPC_URL`),
   `ORACLE_CHAINLINK_RPC_URL` (or `RPC_URL`), `ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS` (default 10 min, at most 1 h on
   4663; `ORACLE_CHAINLINK_MAX_AGE_MS` at most 25 h), `ORACLE_ATTESTATION_FILE`; optional: `ORACLE_PYTH=1` +
   `PYTH_API_KEY` (https only; licence VERIFY C6), `ORACLE_HTTP_SOURCES` (`tsPath` + `maxAgeMs` ≤ 30 s; Finnhub
   refused). The service (and the preflight `scripts/network-profile.ts`) refuses to start on 4663 when any
   production rule fails (`services/oracle/src/production.ts`: a Chainlink feed per ticker with an in-session max
   age ≤ heartbeat + 1 h, a DEX confirm pool with `minDepthUsd` ≥ 10,000 for every ticker, the bounds above).
   Synthetic sources cannot be constructed on 4663.

### Oracle signer attestation (VERIFY E1)

What the contract checks: only the timelock registers; the measurement must be allow-listed; the
recorded `attestationOf(signer)` = `keccak256(abi.encode(ATTESTATION_TYPEHASH, chainid, oracle, signer,
platform, measurement, keccak256(quote)))`; after `requireAttestations()` no signer can be activated
without it. What it cannot check: the quote's vendor signature — that is the operator's job, and anyone
can redo it during the timelock delay from the published quote.

1. Build the oracle enclave reproducibly; publish the source tag and the expected measurement (TDX
   MRTD/RTMRs, SEV-SNP MEASUREMENT, Nitro PCR0-2, hashed to 32 bytes).
2. The enclave generates its signer key inside, then gets
   `bun run --cwd services/oracle attest report-data --chain 4663 --oracle <AttestedOracle> --signer <key>`
   (= `AttestedOracle.reportDataOf(signer)`) into the first 32 bytes of its quote's report data.
3. Write `attestation.json` `{platform, measurement, quote, signer, chainId, oracle}`; verify the quote
   with the platform verifier (Intel DCAP QVL / AMD SEV-SNP VCEK chain / AWS Nitro root certificate):
   signature chain, TCB status, measurement == published build.
4. `bun run --cwd services/oracle attest register --chain 4663 --oracle <AttestedOracle> --doc attestation.json`
   checks the binding (chain, oracle, signer, reportData inside the quote) and prints the digest and the
   two timelock calls: `setMeasurement(measurement, true)`, `setAttestedSigner(signer, platform,
   measurement, quoteHash)`. Propose both; publish `attestation.json` (the oracle serves it at
   `GET /attestation` with `ORACLE_ATTESTATION_FILE`).
5. After execution: `attestationOf(signer)` equals the printed digest, `measurementOf(signer)` the
   measurement. Then `requireAttestations()` and `setSigner(<bootstrap signer>, false, 0)`.
6. Revoking a build: `setMeasurement(m, false)` (blocks new registrations) and `setSigner(s, false, 0)`
   for every signer whose `SignerAttested` event carries `m`.

### Corporate actions (Stock Token multiplier)

- Dividends (small, immediate `uiMultiplier` moves): nothing to do while within the band; re-anchor
  (`setMultiplier(token, <current uiMultiplier>)`) when `source-check` / drift approaches it.
- Splits / large changes (Robinhood stages `newUIMultiplier()` + `effectiveAt()` and pauses the feed with
  `oraclePaused()`): `source-check` warns "pending multiplier". Before `effectiveAt`, propose
  `setNextMultiplierAnchor(token, newUIMultiplier)` so valuations keep working across the change; after
  it, `setMultiplier(token, new)` and `setNextMultiplierAnchor(token, 0)`. While `oraclePaused()` is set
  the oracle drops the Chainlink observation (and the DEX confirm) for that ticker: Chainlink is the only signing
  source, so nothing is signed for it in session and after `maxPriceAge` its valuations, trades and liquidations
  revert `StalePrice` until the pause ends; off-hours the price stays held at the last Chainlink price. Expect
  `oracle_source_failing:chainlink` for the ticker during the pause.

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

## Rollback and incidents (mainnet)

Fast levers (no delay): the GUARDIAN's `config.setNewBooksPaused(true)` (new charters / books / deposits stop;
redemptions keep working), disabling a KMS key (`aws kms disable-key`: that role stops signing at once),
stopping `bookrunner@mainnet`, committee `REVOKE_KEY` / risk kill on a book. Everything else goes through the
timelock (48h); the multisig can `cancel` any scheduled operation during the delay.

| Situation | Immediate | Then |
|---|---|---|
| Broadcast interrupted (partial deploy) | Do not start services or file charters. forge writes `deployments/4663.json` before it sends the transactions, so the record exists but `verify` FAILs (contracts without code, roles missing). | Resume: `bash scripts/forge.sh script script/DeployMainnet.s.sol:DeployMainnet --sender <deployer> --resume --interactive` (ETH_RPC_URL / DEPLOY_INPUT as in deploy-mainnet.sh). Or abandon: if the deployer still holds config `DEFAULT_ADMIN_ROLE`, renounce it; redeploy with a new deployer and a new record. A half-deployed config is never reused. |
| VerifyHandover FAIL after broadcast | Do not start services / file charters. | A row the deployer can still fix (it holds a role): fix and renounce from the deployer. Any other row: multisig -> timelock proposal (48h), then `deploy-mainnet.sh verify` until all PASS. |
| Service key misuse / KMS key exposure (MARK_SIGNER, RISK, OPS_VENUE, JURY, KEEPER) | Disable the KMS key; stop the service; GUARDIAN pauses new business if funds can move. | Timelock: `revokeRole(role, old)` + `grantRole(role, new)`; new KMS key id in the env file; restart. |
| Oracle signer compromised | Disable its KMS key (prices stop; consumers go stale after `maxPriceAge`, trades after `maxTradePriceAge`); pause new business. | Timelock: `AttestedOracle.setSigner(old, false, 0)` + register the new signer with its attestation. |
| Desk session key compromised | Committee `REVOKE_KEY` (2-of-3) or risk kill of the mandate. | Re-mandate (Operations), new `DESK_KEY_PRIVATE_KEY_<bookId>`. |
| Wrong parameter / Stock Token / implementation | Pause new business if it affects new books. | Timelock proposal correcting it (registry, config, factory). Live books keep their implementation until upgraded through the timelock. |
| Contract bug in a live book component | Pause new business; risk kill on affected books (reduce-only); keep redemptions open. | New implementation + timelock batch (`setImplementations`, `upgradeToAndCall` per proxy), 48h. |
| Malicious / mistaken scheduled timelock operation | Multisig `TimelockController.cancel(id)` within the 48h. | Investigate the signer set; rotate Safe owners. |
| Multisig owner key lost / compromised | Safe owner rotation (Safe-level; the timelock roles stay with the Safe address). | — |
| Services host lost | Disable the KMS keys if the host may be compromised. | Rebuild from MAINNET.md (keys stay in KMS; restore env file, `4663.json`, DB dump). Never run two stacks with the same keys at once. |
| Wind-down of the protocol | Pause new business. | Retire each book (Operations "Wind-down"); everything else stays timelock-governed. |

## Switching testnet books to real Orderly (Robinhood Chain testnet 46630)

Goal: the Orderly-venue books (NVDA = book 1, TSLA = book 2) leave the mock venue (`MockOrderlyVault` +
`services/mock-orderly`) for Orderly's testnet. RHX5 (book 3) stays on the in-house PoolEngine and is not touched.
**Status 2026-10-18: blocked.** Orderly has not enabled Robinhood testnet for us (venue stage below), and the
code cannot yet do the switch end to end (gaps G1-G8 at the end of this section, VERIFY O17-O22). Nothing here
sends a transaction before step 3.

### 0. Readiness check (read-only; run first and after every step)

```bash
bun scripts/orderly-readiness.ts                      # testnet; --mainnet for 4663; --json for machines
bun scripts/orderly-readiness.ts --stage venue        # exit 0 = Orderly has enabled the chain / token / broker
bun scripts/orderly-readiness.ts --builder-key ed25519:<public key>   # also: that key is registered for the admin account
```

It reads (eth_call / public GET only): the Orderly Vault's code, `getAllowedToken(keccak256("USDG"))` (must be the
testnet USDG `0x7E95…802F`), `getAllowedBroker(keccak256("bookrunner"))`, the chain in `/v1/public/chain_info` (with
this vault and `bookrunner` in its `broker_ids`), USDG for the chain in `/v1/public/token` (6 decimals, same
contract) and USDG's on-chain `decimals()` (stage **venue**); the broker in `/v1/public/broker/name`, the admin
wallet's account (`/v1/get_account`), our builder symbols `PERP_NVDA_USDC_bookrunner` / `PERP_TSLA_USDC_bookrunner`
in `/v1/public/info` and the equity markets already listed (stage **builder**); and, from
`contracts/deployments/46630.json` (`--deployment` overrides; skipped when absent), `config.usdc()`,
`config.orderlyVault()`, the factory's OrderlyAdapter implementation hashes and, per Orderly book, the adapter's
vault (mock or real), token and hashes, Orderly accounts (v3) and whether it is empty (stage **books**). Exit 0
only when every row of the selected stages passes (FAIL gates; WARN / INFO / SKIP do not); 1 = not ready; 2 =
usage error.

Cron (testnet host, `bookrunner` user; read-only, outbound HTTPS only): poll the venue stage and keep the last
result, so the day Orderly enables the chain shows up without anyone re-running it:

```cron
*/30 * * * * cd /opt/bookrunner/app && ./node_modules/.bin/bun scripts/orderly-readiness.ts --stage venue --json > .data/testnet/orderly-readiness.json 2>&1; echo "$(date -u +\%FT\%TZ) exit=$?" >> .data/testnet/orderly-readiness.log
```

There is no alerts rule: exit 0 of `--stage venue` (`"ready": true` in the JSON) is the signal; it does not page.

Findings 2026-10-18 (testnet): vault code PASS; `getAllowedToken` is 0x0 for USDG and for USDC;
`getAllowedBroker("bookrunner")` false (`orderly`, `woofi_pro`, `mythos` true); chain 46630 absent from
`chain_info`, USDG absent from `/v1/public/token`; broker `bookrunner` and the admin account `0xaa04…2e5c` exist; no
`_bookrunner` symbol; the only equity market is Orderly's own `PERP_TSLA_USDC`; every books row FAILs (books 1 and 2
on the mock vault, mock USDC, pre-v3 adapter implementation (devnet account ids), IF 30,000 + MM ~134,000-138,000 venue-side each). VERIFY O1-O3,
O7, O14, O17.

### 1. What the switch is (and why books 1 and 2 cannot be moved in place)

- Every OrderlyAdapter stores the Orderly vault, the settlement token and its broker / token hashes at
  `initialize`; no function changes them, and `UpgradeOrderlyAdapters.s.sol` keeps them for existing proxies.
- The protocol settles in `config.usdc()` (mock USDC on testnet, `0x04De…3523`), cached at construction by every
  book component (UnderwritingVault, tranches, RevenueRouter, desk) and by BkrnFeeRouter, Backstop and the
  PoolEngine. The real vault only takes the token `getAllowedToken(keccak256("USDG"))` returns: testnet USDG.
- Books 1 and 2 hold balances venue-side, so even the account migration (`migrateToOrderlyAccounts`, empty
  adapters only) is refused for them.

So the switch is **a testnet deployment whose `config.usdc()` is testnet USDG and whose `config.orderlyVault()` is
the Orderly testnet vault, NVDA and TSLA chartered again on it (new book ids, Orderly symbols
`PERP_<T>_USDC_bookrunner`), and books 1 and 2 retired** (Operations "Wind-down"). No script deploys that today (G1).

### 2. Orderly side (Orderly, then the builder admin in Orderly One)

1. **Orderly** (request through the builder channel; nothing we can do on-chain): allow USDG
   `0x7E955252E15c84f5768B83c41a71F9eba181802F` and broker `bookrunner` on the Robinhood testnet Vault
   `0x2A5b650A894409372DDeE241EDAC92d4152bE24d`, and list chain 46630 in `chain_info` / `token`. Done when
   `orderly-readiness.ts --stage venue` exits 0.
2. **Admin registration** (admin wallet `0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9`): done, Orderly account
   `0xaa04410b18eb0856e02832221f24b2cd37fde7c6f6f8eec83fe95a2f62702e5c` (builder row `admin account`). Create an
   Orderly key for that account (scope `read,trading,asset`, signed by the admin wallet) and hand its base58 secret
   to the operator as `ORDERLY_BUILDER_KEY_SECRET`: with the secret set, ops-venue treats the key as registered and
   never registers it itself (`loadOrCreateBuilderKey`). Check it with `--builder-key`.
3. **List the markets** (Perp Anything): `PERP_NVDA_USDC_bookrunner` and `PERP_TSLA_USDC_bookrunner` (Orderly appends
   the broker id to builder symbols, VERIFY O14), market session 24/5 (RWA). Index price source: our
   builder-pushed oracle feed `ORACLE_bookrunner` (`base_ccy` NVDA / TSLA; pushed by ops-venue, G2 / O18). Testnet prices are
   synthetic (no testnet Chainlink feeds, VERIFY C4): do not mix our feed with real-market sources on testnet, or the
   index and our marks diverge. With `ORDERLY_LISTING_MODE=manual` (the live default) ops-venue only waits for each
   listing (alert `venue_listing_pending`, `/health` `orderlyListing`) and picks it up within 5 minutes once the market
   shows on `GET /v1/public/info/PERP_<T>_USDC_bookrunner` with a launched status; in POST_ONLY the agent quotes
   maker-only to build the launch depth (`AGENT_VENUE_POST_ONLY_QUOTE`), then normally once it is ACTIVE.
4. **IF accounts**: each symbol is assigned to one IF account, funded strictly above 100 USDG per effective symbol on
   testnet (VERIFY O10). The protocol's IF account is the book's `OrderlyIFAccount` (`adapter.accountId(0)`, owner
   `adapter.ifAccount()`). It exists only once the new book is created and its delegate signer confirmed (step 3.4),
   and the book funds it itself at window close (`depositToVenue(IF)` = `Vault.depositTo(ifAccount, …)`), so assign
   it after step 3.4. Confirm with Orderly first that a contract (delegate) account can be a symbol's IF account
   (VERIFY O10, open); a builder-held IF account is not implemented (G5).

### 3. Operator side (testnet: the deployer is `config.timelock()`)

1. **Deployment with the real externals** (G1, not implemented): testnet USDG as `config.usdc()`, the Orderly testnet
   vault as `config.orderlyVault()`, the OrderlyAdapter implementation hashed from `DEPLOY_ORDERLY_BROKER_ID=bookrunner`
   and `DEPLOY_ORDERLY_TOKEN=USDG` (a fresh deployment has v3 adapters: no migration). Keep the current record as
   `contracts/deployments/46630.mock.json` for the rollback (dev.ts always reads `contracts/deployments/46630.json` on
   testnet). Testnet USDG for LPs, IF and MM has to come from somewhere (VERIFY O17). The charter rule
   `ifTargetUsd >= venueMinIf` defaults to 25,001 USDG; on testnet the deployer may lower it
   (`config.setVenueMinIf(0, 101e6)`, above the 100 USDG testnet requirement).
2. **`UpgradeOrderlyAdapters.s.sol`** applies only to an existing deployment whose config already points at the real
   vault and USDG (none today):
   ```bash
   DEPLOY_ORDERLY_BROKER_ID=bookrunner DEPLOY_ORDERLY_TOKEN=USDG MIGRATE_ORDERLY_ACCOUNTS=true \
   DEPLOY_OUT=deployments/46630.json PRIVATE_KEY=<deployer> \
     bash scripts/forge.sh script script/UpgradeOrderlyAdapters.s.sol:UpgradeOrderlyAdapters --rpc-url $RPC --broadcast
   ```
   (`MIGRATE_ORDERLY_ACCOUNTS` is a forge bool: `true` / `false`.) It registers the new implementation for future
   books, upgrades every Orderly proxy and migrates only empty, not-yet-migrated adapters. **Do not run it on
   today's deployment**: the mock vault only allows `keccak256("USDC")`, so with `DEPLOY_ORDERLY_TOKEN=USDG` every new
   Orderly book would revert `TokenNotAllowedByVenue` at `initialize` (charter finalize fails), and books 1 and 2 are
   skipped by the migration (not empty).
3. **Charter NVDA and TSLA** on the new deployment (charter symbols `PERP_NVDA_USDC` / `PERP_TSLA_USDC`: with
   `ORDERLY_MODE=live` the services trade `PERP_<T>_USDC_<ORDERLY_BROKER_ID>`, G3), `ifTargetUsd` above 100 USDG and
   `>= venueMinIf`; then `scripts/record-books.ts`.
4. **Delegate signer, per new Orderly book**: `adapter.setDelegateSigner(<OPS_VENUE address>)` registers the ops-venue
   EOA on the vault for the adapter (MM account) and its OrderlyIFAccount (IF account) and emits `AccountDelegate`.
   ops-venue in live mode then, per contract: finds that log on the record's `orderlyVault` from `startBlock`, gets
   `GET /v1/registration_nonce`, signs EIP-712 `DelegateSigner` with the ops-venue key and posts
   `POST /v1/delegate_signer` (this creates the contract's Orderly account). It then generates the book's ed25519
   keys in `OPS_KEYS_DIR` (MM trade key `read,trading`; IF / MM ops keys `read,asset`; TTL `OPS_TRADE_KEY_TTL_DAYS` 30
   / `OPS_OPS_KEY_TTL_DAYS` 365) and registers each with `POST /v1/delegate_orderly_key` (EIP-712
   `DelegateAddOrderlyKey`, `delegateContract` = the account's owner). The agent's OrderlyVenue loads the trade key
   from the same key store. Then step 2.4 (assign the IF account).
5. **Deposit fees**: the real vault may charge a native deposit fee (`adapter.depositNativeFee`): `fundNative` each
   adapter before the window closes, or set `OPS_NATIVE_TOPUP_MAX_WEI` (VERIFY O5).
6. **Services, mock to live**: in `.env.testnet` (keys set there override the dev.ts testnet defaults), then restart:
   ```bash
   ORDERLY_MODE=live
   ORDERLY_BASE_URL=https://testnet-api.orderly.org
   ORDERLY_BROKER_ID=bookrunner
   ORDERLY_TOKEN=USDG
   ORDERLY_LEDGER_ADDRESS=0x1826B75e2ef249173FC735149AE4B8e9ea10abff   # testnet Ledger (withdraw EIP-712 domain); default = mainnet's
   ORDERLY_BUILDER_ACCOUNT_ID=0xaa04410b18eb0856e02832221f24b2cd37fde7c6f6f8eec83fe95a2f62702e5c
   ORDERLY_BUILDER_KEY_SECRET=<base58 seed of the admin account's Orderly key, step 2.2>
   OPS_FEE_SWEEP_AUTO=false   # G6: the admin account is not the ops-venue key's
   # ORDERLY_ORACLE_WS_URL=wss://testnet-ws-oracle.orderly.org   # default for testnet-api.orderly.org; undocumented (VERIFY O18)
   # ORDERLY_ORACLE_ACCOUNT_ID / ORDERLY_ORACLE_KEY_SECRET: the account that pushes ORACLE_bookrunner (default: the builder account + key above)
   # ORDERLY_EIP712_CHAIN_ID defaults to CHAIN_ID (46630)
   ```
   dev.ts keeps starting mock-orderly (and trader-sim, unless `--no-sim`) on testnet whatever `ORDERLY_MODE` is (G7); they no longer
   serve the Orderly books. In live mode the oracle publishes its signed prices per venue symbol (`bkrn:oracle:venue-feed`) and ops-venue pushes them to the Builder Oracle WebSocket at >= 1/s in session (log `live builder price push started`, state in `bkrn:ops-venue:builder-feed`, alert `builder_price_push`).

### 4. Verification

- `bun scripts/orderly-readiness.ts` exits 0 (all stages).
- ops-venue log: `ops-venue starting` with `mode: live` and the testnet base URL, `builder account ready`,
  `Orderly delegate signer confirmed` (twice per book: adapter and OrderlyIFAccount), `book venue provisioned`.
- `GET https://testnet-api.orderly.org/v1/get_account?address=<adapter>&broker_id=bookrunner&chain_type=EVM` returns
  `adapter.accountId(1)`; with `address=<adapter.ifAccount()>` it returns `adapter.accountId(0)`.
- After the window closes: the signed venue reports (Redis `bkrn:venue:report:<bookId>`) show IF and MM equal to the
  deposits, the symbols turn `ACTIVE` (readiness `symbol` rows PASS), the agent quotes, and the first mark reconciles
  against Orderly's statement (Operations "Mark reconciliation break").

### 5. Rollback to the mock venue

1. While real-venue books hold funds: GUARDIAN `setNewBooksPaused(true)`, then retire them (`MarketCharter.retire`;
   ops-venue recalls IF and MM, final mark, holders redeem). Funds on Orderly are out of reach of the mock stack.
2. Remove the step 3.6 keys from `.env.testnet`, restore the mock record
   (`cp contracts/deployments/46630.mock.json contracts/deployments/46630.json`) and the matching `.data/testnet/` state
   (mock venue snapshot, ops keys, sagas: back it up before step 3.6), restart the stack (ops-venue and mock-orderly
   cache account ids).
3. `orderly-readiness.ts`: the books rows show the mock vault again (FAIL expected there).

### Gaps between the switch and the code (2026-10-18)

| # | Gap | VERIFY |
|---|---|---|
| G1 | No deployment path for "real Orderly, mocks elsewhere" on testnet: `Deploy.s.sol` always deploys MockERC20 USDC + MockOrderlyVault; `DeployMainnet` `REHEARSAL=1` takes real externals but needs Stock Tokens, Chainlink feeds and Uniswap v3 on testnet, which are not published there (VERIFY T3, C4). Adapters cannot be rebound to another vault / token. Source of testnet USDG unknown. | O17 |
| G2 | **Closed in code (2026-10-18).** Builder-pushed index price: the oracle publishes its signed price per venue symbol every tick (`bkrn:oracle:venue-feed`); ops-venue pushes it to the Builder Oracle WebSocket (`src/builderOracle`, documented auth / message / ping) every second in session, re-sending the latest signed price between oracle ticks (testnet: every 2 s) and stopping when the oracle holds (session closed) or has no fresh price (a held price older than 10 s / 3 ticks counts as no price); alert `builder_price_push` after 30 s (a market never listed on Orderly yet, G4: logged only), or when the push status is old or missing. The session in which the oracle holds follows the charter sessions: they must equal the Orderly One market session of each listing (step 3). Still to confirm with Orderly: the testnet host (default `wss://testnet-ws-oracle.orderly.org`, undocumented), the auth / reject message shapes, and whether the builder account (vs the admin account, G6) may push `ORACLE_bookrunner`. | O18 |
| G3 | **Closed (2026-10-18).** Symbol naming: one mapping (`packages/shared/src/venueSymbol.ts`) used by ops-venue, the agent and risk: `ORDERLY_MODE=live` -> `PERP_<T>_USDC_<ORDERLY_BROKER_ID>` (`PERP_NVDA_USDC_bookrunner`), mock -> the charter symbol verbatim. Charters, marks and the UI keep `PERP_NVDA_USDC`. Charters with a symbol no Orderly market can carry are rejected at filing (API) and blocked by the jury; a live book without a market is tracked for reports / withdrawals only (alert `venue_symbol_unmapped`). | O19 |
| G4 | **Closed in code (2026-10-18).** `ORDERLY_LISTING_MODE=manual` (default with `ORDERLY_MODE=live`; `api` stays the default in mock mode): the admin lists each market in Orderly One (step 2.3); ops-venue never calls a listing or symbol-status endpoint, provisions the book's accounts and keys and follows `GET /v1/public/info/{symbol}` per symbol (15 s doubling to 5 min, 5 s timeout, 4 at once: a book waiting for its listing never holds up another). State per symbol (awaiting / listed / missing, open for new risk or restricted) in `bkrn:ops-venue:symbol-issues` and the API's `/health` `orderlyListing`. Alerts: `venue_listing_pending` (warning; critical after a Live book has had no market for 30 min), `venue_market_restricted` (REDUCE_ONLY / POST_ONLY warning, DELISTING / DELISTED on a Live book critical), `venue_market_missing` (a listed market gone: Live critical), `venue_listing_check` (5 failed checks), `venue_delist_pending`. The agent quotes and hedges reduce-only while its market is not open (`AGENT_VENUE_MARKET_GATE`); in Orderly's POST_ONLY launch phase it quotes both sides maker-only (POST_ONLY orders within the mandate) to provide the launch depth (`AGENT_VENUE_POST_ONLY_QUOTE`, default true with `ORDERLY_MODE=live`; false = reduce-only); the builder price push pages for a listed market that went missing or restricted. Retirement: set the market REDUCE_ONLY in Orderly One if needed and delist it there when the IF withdrawal of a retiring book waits on it (alert `venue_delist_pending`; ops-venue retries every minute, 24 h ceiling). | O20 |
| G5 | IF account: whether an OrderlyIFAccount (contract / delegate account) can be a symbol's IF account is not confirmed; no builder-held IF fallback. | O10 |
| G6 | The builder admin account belongs to `0x9c1B…e8b9`, not to the ops-venue key: ops-venue's builder fee withdrawal signs a plain `Withdraw` with the ops-venue key and fails; sweep manually (`OPS_FEE_SWEEP_AUTO=false`). | O21 |
| G7 | dev.ts testnet profile: `ORDERLY_MODE=mock` unless `.env.testnet` sets it, no `ORDERLY_*` live values, mock-orderly always started (trader-sim unless `--no-sim`). Workable through `.env.testnet` (step 3.6); no live-venue profile switch. | O22 |
| G8 | Orderly's testnet itself: chain 46630 in `chain_info`, USDG and the broker allowed on the vault (Orderly action). | O1-O3, O7 |
