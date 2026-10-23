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
      then do not charter Orderly books (PoolEngine books are unaffected), or decide (2P, owner sign-off) to run
      the builder IF mode (OrderlyAdapter v4 `setIfAccountOwner`, `ORDERLY_IF_MODE=builder`: IF custody with an
      operator EOA per book, testnet step 2.4).
- [ ] Uniswap v3 SwapRouter02 / factory / QuoterV2 on RHC and the Stock Token pools for each hedge asset (route,
      depth: `scripts/check-pools.ts`, VERIFY U1-U5); USDG (settlement token).
- [ ] VERIFY C2: `source-check` green against a mainnet RPC ("Real prices" below): the oracle publishes
      per-share prices (Chainlink RHC feeds are per token, multiplier included).
- [ ] VERIFY E1: TEE platform chosen, oracle signer attestation verified ("Oracle signer attestation" below),
      attestation digest of each oracle signer known (input `oracle.signers`).
- [ ] Orderly builder onboarding done: broker id, IF accounts, builder key (MAINNET.md §3).
- [x] Safe multisig deployed on RHC: `0x848c91323f720DEf985adbCC85FA40E3405B70DF` (checked on-chain 2026-10-22: Safe
      v1.4.1, canonical L2 singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, CompatibilityFallbackHandler
      `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`, no guard, no modules, threshold **2 of 3**, owners
      `0x37A94ba80bCaBc9aa435068210360d9CD4Ad1ac4`, `0x0E670BbfFc7ead71e4eb05DFe77016729B6b7C0E`,
      `0x5Ef5a5300803C2e0b45d504b6Bd68c7dce26b62b` (an EIP-7702 delegated account: MetaMask smart account,
      delegate `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`), nonce 11; set in `contracts/deploy-inputs/4663.json`).
- [x] Guardian, treasury (expense + slash) and the four BKRN allocations = the same Safe (owner decision 2026-10-22);
      Risk Committee (three distinct seats) = `0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9` and the Safe owners
      `0x0E67…7C0E`, `0x5Ef5…b62b`. Hedge route fee tiers set
      to the live USDG pools (NVDA / AAPL 500, TSLA / MSFT / AMZN 3000).
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
       It deploys the timelock (`BookrunnerTimelock`: OZ TimelockController with enumerable role holders; min delay 48h, proposer = executor = canceller = multisig, no admin)
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
       - **no extra role holder** (audit 2026-10 D): the config's DEFAULT_ADMIN (= the timelock only), GUARDIAN,
         MARK_SIGNER, RISK, OPS_VENUE, JURY and KEEPER holders, and the timelock's admin / proposer / executor /
         canceller holders, are enumerated on-chain and must be exactly the input's (a stray admin fails);
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
    **Launch gate (audit 2026-10).** Every book is created on the deployment that carries the audit fixes; no
    book, desk or mandate is carried over from an older deployment. Book components are clones bound at creation:
    an older BookrunnerDesk clone keeps the unbounded RISK flatten in a split window (M-2) and the 300 s desk print
    rule, an older MMMandate clone keeps the old `validateMandate` (M-3: 8/25-style terms), and an older
    PoolEngineAdapter cannot re-mandate against a new engine. The Book proxy itself is upgradeable, its clones are
    not, so recreate, never upgrade in place. Check before filing: `BookFactory` implementation slots (`DESK`,
    `MANDATE`, `ENGINE_ADAPTER`) point at the current implementations, and VerifyHandover passes.
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
13b. [ ] Insurance pool first-loss seed (before any window closes). The treasury multisig approves and calls
        `InsurancePool.depositFirstLoss(seed)`, with `seed = scripts/launch-plan.ts poolSeedUsd(launch sizes)` (≈ 91,671
        USDG for NVDA / TSLA at 25,001 and RHX5 at 10,000). Queued deposits count only after their epoch is processed,
        so at launch the slice alone funds every pool-funded IF. Each IF must fit 30% of the pool (`marketCapBps`; the
        books on one underlying share it), and all of them together must fit the free cash above the 20% buffer.
        Check `maxAllocation(bookId, market) >= ifTargetUsd` per book before `subscriptionEnds`, otherwise
        `closeWindow` reverts (retry after a top-up). Premiums go wholly to the slice until depositor shares exist.
        Withdrawing from the slice is timelock-only (48 h), from free cash, never while withdrawals are due, and never
        below 10% of the pool. Once depositors exceed about 9× the slice, new allocations stop until the treasury tops
        it up (alert `pool_first_loss_low`). Do NOT apply the devnet demo parameters (`epochLength` / `cooldown` /
        `processGrace`): mainnet keeps 7 d / 7 d / 24 h.
        Ordering when depositors' money should count at launch: open deposits (`requestDeposit`) at least one full
        epoch before the books' `subscriptionEnds`, so that epoch ends and is processed first (`processEpoch` waits for
        no book mark while no pool-funded book is active yet); the processed deposits then count towards the pool, and
        the seed only has to keep the slice at 10% of it plus the cap / buffer headroom (recompute with the processed
        total). Without that lead time, seed the full ≈ 91.7k above.
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
- Split window (audit M-2): from `effectiveAt` until the oracle signs the first live price after it (normally
  the next open), `StockTokenRegistry.valueUsd` for that token reverts `MultiplierChangedSincePrice`, because the
  held price is still in pre-change shares. During that window:
  - desk hedges and flattens of the token revert. That includes the RISK flatten, which is deferred until the
    reprice instead of selling unbounded;
  - the risk service values the token at its pre-change multiplier (on-chain `basisMultiplier`) and never sells
    it; only when that multiplier is unknown does it hold back the `DRAWDOWN` / `HEDGE_BAND` breaches;
  - the mark service refuses for up to one mark interval (warn log "split window: refusing ..."), then commits
    held marks with the token at the multiplier of the price's basis. For a live-mode token that multiplier comes
    from the token's `UIMultiplierUpdated` events (paged over `MARK_SPLIT_LOG_LOOKBACK_BLOCKS`; exact), else
    `StockTokenRegistry.basisMultiplier` (on-chain: the pre-split anchor for a token-side change, within the band of
    the true value); for a stored-mode token it is always the on-chain value, which is exact (the registry records
    every change). Only when neither is known is the previous mark's value carried forward (no P&L), and only with
    no previous value either is the token valued at 0 (error log "no basis multiplier and no previous mark value"):
    then check the token and the lookback range. The refusal is counted from the first change after the basis;
    when the events are out of range and your re-anchor lands inside the window, it can restart once, for at most
    one more interval (bounded).

  All of this is expected and clears by itself at the reprice. The Chainlink source also drops a round from
  before a split until the feed's next round. A dividend update during a hold has the same effect until the
  open. In stored-multiplier mode (devnet / testnet), a `setMultiplier` that changes the value counts as the
  change.
- Engine markets (audit N-1): from the moment a split is pre-approved (`setNextMultiplierAnchor`) or staged on the
  token, PoolEngine markets on that price id (or an index containing the token) are close-only (`SplitPending`).
  In the window, every voluntary trade reverts (`SplitWindow`); liquidations still run. The market reopens for
  new risk only after the reprice **and** the cleanup: `setMultiplier(token, new)` and
  `setNextMultiplierAnchor(token, 0)`. Do the cleanup right after the first live post-split print. Existing
  positions are not rebased: wind down or cap engine markets before a split.
- If the issuer stages another change before you re-anchor a split, valuations of the token stop until your
  re-anchor plus the next live print, and so does every voluntary engine trade on its markets (closes and margin
  withdrawals too; liquidations still run): re-anchor promptly.
- The RISK flatten of a token in the split window waits for the reprice even when the price is stale (for example
  the reopen before the feed's first post-split round); expect the kill sequence to retry it. It also waits
  (`StockTokenRegistry.checkPriceBasis` reverts) in two cases without a split window proper:
  - a change beyond the band activates on the token without a pre-approved anchor (`MultiplierOutOfBand`): until
    your `setMultiplier` re-anchor; pre-approve splits with `setNextMultiplierAnchor` before `effectiveAt`;
  - after an oracle cutover (a new AttestedOracle: `lastLiveAt` is 0) or for a price id never published, every
    live-mode token's flatten waits for its first live print on the new oracle, because enabling live mode stamps
    a change. Cut a new oracle over in session, and push a live price for every token before relying on the RISK
    flatten.
- Stored-multiplier mode (devnet / testnet): give engine markets a close-only period by calling
  `setNextMultiplierAnchor(token, new)` before `setMultiplier(token, new)`, and clear it afterwards.

### Opening the first in-house engine market on mainnet (Plan B2: NVDA on the PoolEngine)

The trading page (`/trade`, ARCHITECTURE §5.1) lists an engine market as soon as its book is Live; until then it
shows "No market open yet". Guarded launch: small, insured, watched.

1. [ ] **Liquidation keeper first.** Liquidations are permissionless (`PoolEngine.liquidate(marketId, trader,
       priceData)`, the liquidator earns half the liquidation fee) but no protocol service liquidates real traders:
       trader-sim only sweeps its own positions. Run a keeper for the market before the window closes (scan
       `Trade` / `MarginChanged` traders, `isLiquidatable`, liquidate with the oracle's signed bundle; while held it
       liquidates below 2x initial margin at the held price). Without one, a position under maintenance waits and its
       loss grows into IF bad debt.
2. [ ] **Charter with venue PoolEngine** (`venue` 1 = `BRTypes.VENUE_POOL_ENGINE`), as step 11 above: underlying the
       NVDA Stock Token (`tokenUnderlying(NVDA)`), an engine symbol (e.g. `NVDA-PERP`, not Orderly's
       `PERP_NVDA_USDC`), `takerFeeBps` ≤ 100 (`MAX_ENGINE_TAKER_FEE_BPS`), `ifTargetUsd` ≥ `venueMinIfUsd(1)` =
       **10,000 USDG** (`IF_BELOW_VENUE_MIN` otherwise; size it so the IF covers a gap of the off-hours requirement on
       the whole cap, i.e. ≥ 20 % of `maxInventoryUsd` with the default 10 % initial margin), and a **small
       `mandate.maxInventoryUsd`** (e.g. 10,000-25,000 USDG): it becomes the engine's per-side open-interest cap and
       funding normaliser (`inventoryCapUsd`), the desk's quote cap is clamped to it, so it bounds what the pool can
       owe. `maxSkewBps` ≤ `minQuoteWidthBps / 2` (audit M-3); `killAtDrawdownBps` sets the per-period loss budget.
       With `ifFromPool`, check `InsurancePool.maxAllocation(bookId, market) >= ifTargetUsd` before `subscriptionEnds`
       (step 13b).
3. [ ] After the window closes ops-venue deploys the IF and the MM capital to the engine (`depositToVenue`). Check on
       `/trade` in session hours: the market is listed, "Open", the signed price under 15 s old
       (`maxTradePriceAge`), room left = the cap, insurance fund = `ifTargetUsd`. Prepare a tiny order from a test
       wallet and read the "you will sign" summary (PoolEngine address = `adapter.engine()`, the size you typed, a
       slippage limit) before sending.
4. [ ] **Audit N-1 (splits).** Positions are per share and never rebased. Before any NVDA split or multiplier change,
       pre-approve it (`setNextMultiplierAnchor`): the market turns close-only ("Close-only (split pending)" on
       `/trade`), and in the window no voluntary trade fills ("Paused (split)"). Re-anchor right after the first live
       post-split print (Corporate actions above), or wind the market down first. A split announced while open
       interest is large is a reason to lower the cap (re-mandate) beforehand.
5. [ ] Raise `maxInventoryUsd` only through a re-mandate after a period of observed marks, IF stable, no
       `LossBudgetBreached`, and the keeper proven (step 1).

## Operations

- **Kill switch for new business**: `BookrunnerConfig.setNewBooksPaused(true)` (GUARDIAN or timelock)
  — pauses new charters, books and deposits. Redemptions keep working; there is no switch for them.
- **Re-mandate after a kill**: committee `proposeAction(bookId, "REMANDATE", abi.encode(mandate))`,
  2-of-3 approve; the sponsor re-registers desk keys. Terms must have `maxSkewBps <= minQuoteWidthBps / 2`
  (audit M-3; a re-mandate of the pre-fix devnet terms 8/25, 12/30, 10/25 reverts `InvalidMandate`).
- **Engine loss budget spent** (in-house books, audit M-3): traders' new risk reverts `LossBudgetExceeded`
  once the pool has lost more than |killAtDrawdownBps| of its equity at the period's first trade, until the
  next `markInterval` period; reductions, closes and liquidations keep working. Read
  `PoolEngine.lossBudget(marketId)` (anchor, loss, budget, blocked). The kill path is unchanged: the drawdown
  kill at the next mark, or a RISK / committee kill if the loss is not market movement. The budget never
  needs lifting by hand. The engine emits `LossBudgetBreached(marketId, period, loss, budget)` once per period
  (from the first reduction, close, liquidation or close-out that sees it; anyone may call
  `PoolEngine.pokeLossBudget(marketId)`), the risk service publishes the budget state every tick
  (`meta.lossBudget`) and the alert `engine_loss_budget` (critical) pages until the next period re-anchors.
  When risk cannot read the budget (it publishes `meta.lossBudget: null` for an engine book: RPC errors, an engine
  without `lossBudget`, an adapter whose `marketId` / `engine` reads fail), `engine_loss_budget` cannot fire;
  `engine_loss_budget_unreadable` (warning) says so after `ALERT_LOSS_BUDGET_UNREADABLE_SECONDS` (300). The engine
  still enforces the budget on-chain; check risk's RPC and the book's adapter.
- **Engine liquidations** (keeper policy): `PoolEngine.liquidate` is permissionless and pays the liquidator half
  the nominal liquidation fee (`liquidationFeeBps` of the notional at the oracle), from the trader's remaining
  margin first and from the market's IF when the margin is gone (capped by the IF after the bad debt it covers).
  An underwater position therefore always carries a reward. No service of ours liquidates; until outside keepers
  are seen on a market, run one from the operator account (`liquidate(marketId, trader, priceData)` for every
  `isLiquidatable` position, gas from the reward).
- **Delisted or permanently halted underlying (settle price)**. When a Stock Token's market will not trade again,
  the oracle keeps the price held (or stale) and nothing on-chain can price the book finally: held marks defer
  redemptions (audit M-1) for 30 days, then settle at the held price, and engine positions cannot close. Through the
  timelock, propose a final price: `AttestedOracle.proposeSettlePrice(priceId, priceWad)`. It is refused while the
  stored price is live and fresh (`MarketTrading`) and outside 50% of the stored price either way
  (`SettlePriceOutOfBand`). The band is wide and symmetric on purpose: a delisting or halt can move the price a lot
  either way (bankruptcy, cash-out merger), and the guard is the process (timelock, then 3 public days in which a
  wrong price can be cancelled); a move beyond 50% needs a Book-level decision, not this path. It takes effect `SETTLE_PRICE_DELAY` (3 days) after the
  proposal; with the 48 h timelock, schedule it by day 25 of the hold so it is in force before the 30-day fallback.
  While it is pending or in force, books on that underlying (or an index containing it) do not settle held marks at
  the held valuation; that deferral ends 60 days after the hold began whatever governance or the mark service does.
  For an index book, propose the price for the delisted component; for a hedge token outside the book's underlying,
  propose it for the underlying too or flatten the token. In force (`settlePrice(priceId)` returns `effective`):
  - the mark service values the price id at it as a live price and signs non-held marks (warn log "valued at the
    governance settle price"), so redemptions and top-ups settle at it;
  - PoolEngine prices the market at it as held (no voluntary trade). Anyone calls `forceClose(marketId, trader)`
    for every open position (no close-out schedule needed, no fee) promptly: funding keeps accruing until each
    position is closed. Only positions below maintenance at the settle price can be liquidated (with the fee). Then
    retire the book as usual and the adapter recalls the pool and the IF.
  - the mark service refuses a mark (retries later) when it cannot read `settlePrice`; repeated "settlePrice ... failed"
    warnings mean an RPC problem to fix, not a held mark.
  A live print published after the proposal voids it (the market traded again). `cancelSettlePrice(priceId)`
  (timelock) withdraws it at any time: the normal held-mark rules apply again.
- **Subscription window that cannot close**: `closeWindow` reverts while the venue deposit of the IF / MM
  inventory reverts (venue paused, adapter misconfigured), so the book stays in Subscription. Fix the venue side
  and call `closeWindow` again, within 7 days of `subscriptionEnds`: after that anyone may cancel the window, even a
  healthy one nobody closed. `Book.CLOSE_WINDOW_TIMEOUT` (7 days) after `subscriptionEnds`, anyone may call
  `Book.cancelStuckWindow()`: the book is Cancelled and every commitment is refundable 1:1
  (`Tranche.claimCancelledRefund`).
- **Deploy the agent and the risk service together** (audit M-3). The risk service treats a quote that does not
  straddle the oracle as a SKEW breach (kill after `RISK_BREACH_CONFIRM_TICKS`); an agent from before the fix can
  quote one side of the oracle on a book with cached pre-fix terms (8/25, 12/30, 10/25). Roll both from the same
  commit, agent first or in the same restart. Live quotes are judged against the attested oracle price (fresh
  on-chain price or verified signed print), never the agent's reported reference; `RISK_QUOTE_DRIFT_BPS` (default 5,
  0..10, capped at half the mandate's min quote width) is the print drift allowed on top of `maxSkewBps`. "Fresh"
  for the quote check is `RISK_QUOTE_PRICE_MAX_AGE_MS` (default 15 000, 2 000..60 000, checked at startup), not
  the 300 s `maxPriceAge` used for valuation; a held (market-closed) print counts. Without such a price (signed-feed
  outage in pull mode, Redis-only, missing) no quote is checked and the book is held `reduce_only` (status
  `quoteUnverified`) whatever the agent quotes, never killed on SKEW; the hold lifts after
  `RISK_QUOTE_HOLD_RELEASE_TICKS` (default 2, 1..10) consecutive ticks with a fresh attested price. Restore the
  oracle feed or the signed prints; nothing to lift by hand.
- **Mark reconciliation break** (Day-30 kill criterion): freeze new charters until clean; compare the
  mark's `pnl_json` venue section against the venue statement for the period.
- **Wind-down**: `MarketCharter.retire(bookId)` → agents flatten → keeper recalls IF + MM → final
  mark with zero deployed value → `finalizeRetirement` → every holder redeems at the final NAV.
- **Replacing HedgeExecutor, BkrnFeeRouter or the Backstop** (plain, non-upgradeable contracts resolved through
  `config`): deploy the new contract, configure it (HedgeExecutor: router(s), `setV3Factory`, one
  `setRoute` per hedge asset; BkrnFeeRouter: `setBuybackRouter`, `setBuybackParams`, reference
  source), then `config.setAddress("hedgeExecutor" | "feeRouter", new)` through the timelock.
  Desks resolve `config.hedgeExecutor()` on every swap, RevenueRouters resolve `config.feeRouter()`
  on every distribution and `BkrnStaking.notifyReward` only accepts the current `config.feeRouter()`.
  Once the fee-router repoint has executed, anyone calls `migrate()` on the old router: its whole
  settlement-token balance (the pending buyback) moves to the new one, which adds it to its
  `buybackPending` (audit 2026-10 D; a router deployed before that fix has no `migrate`: drain its
  `buybackPending` with `executeBuyback` before the repoint, its buybacks stop once staking points at the
  new router). **Replacing the Backstop** works the same way: deploy, `setMaxCoverBps`, repoint
  `config.setAddress("backstop", new)`, then `migrate()` on the old one moves its whole balance to the new
  one (books and the fee router resolve `config.backstop()` at every call). Agents / risk must run with `HEDGE_POOL_FEE` /
  `RISK_FLATTEN_POOL_FEE` = 0 (or the route's exact fee) against a route-aware HedgeExecutor.
- **Route review**: `bun scripts/check-pools.ts` (read-only) before every `setRoute` proposal and
  periodically; a failing token (no pool, no liquidity, round trip beyond the bound) should be
  re-routed or removed from mandates' `hedgeAllowRoot` before agents hedge it.
- **Stale charters** (audit review M-7): `bun scripts/sweep-charters.ts` lists the charters still Filed after their
  decision deadline (dry run); `--send` expires them from the KEEPER key (fee refunded, bond released; anyone may
  call `expire`). After a MarketCharter / committee repoint, run it with `--charter <old address>`: charters still
  Filed there can no longer be decided.
- **Kill orders are RISK-signed** (Redis is not trusted, SECURITY.md "Off-chain trust boundaries"): agents and
  ops-venue act only on the risk service's signed `KillOrder` (a RISK_ROLE holder; pin it with `AGENT_RISK_SIGNERS` /
  `OPS_RISK_SIGNERS` to take the RPC off the kill path). A forged one is logged `FORGED kill ... ignored` and raises
  `bus_forged_message`: check who can reach Redis. Deploy risk, the agents and ops-venue together: an agent or
  ops-venue from this commit ignores an unsigned kill from an older risk (the on-chain kill still halts and revokes),
  and risk from this commit checks only signed agent quotes, restores only its own signed state (at the first
  restart after the upgrade every book starts from a fresh state and logs it: the old copies carry no signature, which
  is not counted as forged; only a signature that fails verification counts in `bus_forged_message`) and publishes signed states (an agent from this commit
  goes reduce-only after `AGENT_RISK_STATE_TIMEOUT_MS` without one: alert `risk_state_unverified`). A halted agent with
  `killConfirmedOnChain: false` got a signed kill whose on-chain step has not landed (alert `kill_stuck`): complete
  the kill; it resumes after a remandate.
- **Desk session keys** (one per book; an agent quotes new risk only while its key is active on the mandate, so risk
  can verify every quote it judges; without one it runs reduce-only and `agent_no_desk_key` fires, critical after
  `ALERT_NO_DESK_KEY_CRITICAL_SECONDS` on a Live book). Devnet / testnet / testnet-live: the launch registers the
  launch books' keys and then every other book's derived key (`bun scripts/desk-keys.ts --send`: the three launch
  roles, else mnemonic index 1000 + bookId; a book of another sponsor is listed with the call its sponsor makes).
  Mainnet, before the book goes Live: the operator generates the book's key (`DESK_KEY_PRIVATE_KEY_<bookId>` in the
  env file), the agent operator calls `MMMandate.consentKey(key, true)`, the sponsor calls
  `registerKey(key, operator, validUntil, tier >= maxInventoryUsd)`; check `isActiveKey(key)`. Rotation: register the
  new key, set `DESK_KEY_PRIVATE_KEY_<bookId>` and restart the agent, then `revokeKey(old)` (the agent goes
  reduce-only for the restart only). Expiry: `bun scripts/desk-keys.ts` (testnet) reports keys expiring within 30
  days; on mainnet watch `getKey(key).validUntil` and re-register before it lapses (at expiry the agent goes
  reduce-only and the alert fires). A committee `REVOKE_KEY` has the same effect at the next state refresh.
- **Hold alerts** (services/alerts): `held_marks_in_session` (a held run valued in, or lasting through,
  `ALERT_HELD_MARK_SESSION_SECONDS` of open session: a price the NAV uses is held or stale, e.g. a desk token whose
  feed stopped, or the daily mark time never falls in the charter session; settlement is deferred up to 30 days; see
  the mark log "held" reasons), `risk_quote_unverified` (risk holds a book reduce-only for over
  `ALERT_QUOTE_UNVERIFIED_SECONDS` in session: no fresh attested price; restore the oracle feed / signed prints),
  `desk_stale_trade_price` (the desk refused `ALERT_STALE_TRADE_PRICE_MAX` key swaps with StaleTradePrice within
  `ALERT_STALE_TRADE_PRICE_WINDOW_SECONDS`: the agent's signed prices are not reaching the desk; hedging is stuck),
  `bus_forged_message` (a service refused `ALERT_FORGED_MESSAGES_MAX` forged kills / quotes / risk states within
  `ALERT_FORGED_MESSAGES_WINDOW_SECONDS`: nothing acted on them, but something can write to Redis), `agent_no_desk_key`
  and `risk_state_unverified` (above).

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

## Fresh deployment of the public testnet (bookrunner.tech)

Needed when the contracts change in a way that cannot be upgraded (e.g. the 2026-10 audit fixes: testnet v4, 2026-10-21).
Everything old is archived, never deleted: the record as `contracts/deployments/46630.<stamp>.json`, the state, a
database dump and a Redis snapshot under `.data/testnet.<stamp>/`, the database renamed `bookrunner_testnet_<stamp>`.

```bash
sudo bash /usr/local/lib/bookrunner-deploy/backup.sh
sudo systemctl stop bookrunner
sudo bash /usr/local/lib/bookrunner-deploy/update.sh --web-only     # new code, units, web; no restart
sudo bash /usr/local/lib/bookrunner-deploy/public-redeploy.sh       # archive, new DB, forge (as bookrunner), verify
sudo bash /usr/local/lib/bookrunner-deploy/update.sh                # restart: the first start launches the books
```

`public-redeploy.sh --from-forge` resumes after a failed forge step. The launch resumes on its own after a transient
RPC error (`sudo systemctl restart bookrunner`). Check: `/status.json` overall ok, a mark per book, agents quoting.

## Testnet rehearsal on real Orderly (Robinhood Chain testnet 46630)

Goal: a testnet BookRunner whose Orderly-venue books (NVDA, TSLA) are bound to Orderly's REAL testnet vault and settle
in REAL testnet USDG, while Stock Tokens, the swap router and prices stay mock / synthetic (no Stock Tokens, Chainlink
feeds or Uniswap on Robinhood testnet, VERIFY T3 / C4).

**Where it runs.** On the testnet host (`148.113.237.230`, `ssh usecert-ubuntu`, the same VPS as bookrunner.tech) as a
**second, separate stack NEXT TO the public testnet stack**: systemd `bookrunner@testnet-live` (the network-parametrised
template `deploy/server/bookrunner@.service` + the drop-in `bookrunner@testnet-live.service.d/override.conf`: cap 1.5 /
2 GB, `ReadWritePaths` .data + contracts/deployments) running `scripts/dev.ts --network testnet-live --no-web`.
**`bookrunner.service` (the public testnet, bookrunner.tech, books 1 and 2 on the mock venue) keeps running, untouched.**
What the two stacks share, exactly: the host (CPU / RAM / disk), the Postgres server (each stack has its own database
and nothing reads the other's), the Docker daemon / `bookrunner-infra.service` that runs both Redis instances, the
chain (each stack has its own contracts) and Orderly (only the rehearsal talks to it). Everything else is separate:

| | public testnet stack | rehearsal stack |
|---|---|---|
| unit | `bookrunner.service` | `bookrunner@testnet-live` (installed by install.sh / update.sh, never enabled by them) |
| role keys | `BKRN_TESTNET_MNEMONIC` (`.env.testnet`) | `BKRN_TESTNET_LIVE_MNEMONIC` (server: `/etc/bookrunner/testnet-live.env`, root 0600; developer machine: `.env.testnet-live`): every role, the deployer, the desk keys and the gas funder differ |
| record | `contracts/deployments/46630.json` | `contracts/deployments/46630.live.json` |
| database | `bookrunner_testnet` | `bookrunner_testnet_live` |
| Redis | the infra Redis `127.0.0.1:63790`, db 1, `REDIS_PASSWORD` | its OWN Redis instance `redis-live` `127.0.0.1:63791`, db 0, `REDIS_LIVE_PASSWORD` (docker-compose, started by `bookrunner-infra`); the profile refuses the public Redis |
| bus namespace (every pub/sub channel, Redis key and BullMQ queue; messages stamped with it) | `testnet`: `bkrn:testnet:…`, queues `bkrn-testnet-…` | `testnet-live`: `bkrn:testnet-live:…`, queues `bkrn-testnet-live-…` |
| state | `.data/testnet/` | `.data/testnet-live/` (keys, sagas, `dev.log`) |
| loopback ports (API / oracle / charter) | 4400 / 4410 / 4430 (+ mock-orderly 4420) | 4500 / 4510 / 4530 (no mock-orderly, trader-sim or web) |
| public traffic | nginx -> 127.0.0.1:4400 (bookrunner.tech) | none unless configured (optional subdomain, step 3.6) |

Key separation is enforced, not just documented: `deploy-testnet.sh ORDERLY_VENUE=live` and `dev.ts --network
testnet-live` refuse a missing `BKRN_TESTNET_LIVE_MNEMONIC`, one deriving the same deployer address as the public stack's
`BKRN_TESTNET_MNEMONIC` (read from `.env.testnet`, never applied; mnemonics are never printed) and any explicit
`*_PRIVATE_KEY` / `DESK_KEY_PRIVATE_KEY_*` / `BKRN_TESTNET_FUNDER_PK` also present in `.env.testnet`. Belt and braces:
each variant's supervisor publishes its deployer address in its status key, and `dev.ts` refuses to start while the
other variant's status (on the other Redis instance, under the other namespace) is fresh with the same deployer.

**Bus isolation (two layers).** Redis pub/sub channels are global to a Redis server whatever the db index, so a db index
alone would let one stack's risk kill revoke the other's Orderly trade key, its limit state drive the other's agent,
its oracle prices feed the other's quotes and its domain events reach the other's webhooks and jury. (1) Every channel,
key and queue carries the stack's bus namespace (`packages/shared/src/queues.ts` `busNamespace`: `BKRN_BUS_NS`, else
`NETWORK`, else the chain id; the live profile pins `testnet-live`), and published messages carry `ns`: a subscriber
drops (and logs once) a message stamped with another namespace (kill handling in ops-venue, the agent's bus, the API
webhook dispatcher, the charter jury, the builder price feed). (2) The rehearsal runs on its own Redis instance. This
also closes the audit lead "Redis is a shared trust domain" ACROSS stacks: one stack's processes can no longer
publish into, or read, the other's bus. Within a stack Redis stays one trust domain (any process with the stack's
`REDIS_URL` can publish a kill), as before. `dev.ts --network testnet` refuses
`ORDERLY_MODE=live` in `.env.testnet` (the public stack never flips to live Orderly).

**Status 2026-10-18: blocked on Orderly** (venue stage of the readiness check: no token and no broker allowed on the
testnet vault, chain 46630 not listed). The code path is complete (G1-G7 below). Nothing in this section sends a
transaction before step R4.

### Bus namespace: first deploy on a running stack

Before the FIRST `update.sh` with this code on the public testnet host (final review I2 / I3): (1) as the bookrunner
user, `grep -oE '^[[:space:]]*[A-Z0-9_]+[[:space:]]*=' /opt/bookrunner/app/.env.testnet | tr -d ' \t=' | sort | uniq -d`
must print nothing (dev.ts now refuses a key defined twice; fix the file first); (2) `sudo systemctl stop bookrunner`
before `update.sh` (no child of the old dev.ts can restart on the new code with the new namespace during the build;
update.sh starts the stack again and the migration runs with nothing attached); (3) `free -m`: ~100 MB headroom for
`redis-live`.

The bus namespace renames the shared Redis keys (`bkrn:<x>` -> `bkrn:<ns>:<x>`) and the BullMQ queues (`bkrn-<x>` ->
`bkrn-<ns>-<x>`). **Nothing to do by hand:** `scripts/dev.ts` migrates at every start, BEFORE it starts any service
(`scripts/bus-migrate.ts` `migrateBus`), so `update.sh` (`systemctl restart bookrunner`), a manual restart, the
`bookrunner@testnet-live` unit and a future mainnet start are all covered. It renames the legacy shared keys (risk state
+ journal meta, signed venue reports + recent list, oracle last / bundle / venue feed, agent quote / heartbeat, live
NAV, ops-venue status keys, supervisor status) and the legacy queues (pending / delayed jobs: revoke_key, sweep_fees,
webhooks, marks, settlements, ...) of the stack's Redis db; it never overwrites a newer value (a target already
written by the new code wins unless the legacy value carries a newer timestamp; without a timestamp the target is
kept and the conflict logged; a queue moves only while its new name is empty), then writes the marker
`bkrn:<ns>:bus:migrated`, after which it is a no-op. The dev log shows what moved (`[dev] bus namespace "testnet":
moved N key(s) …`, one line per key, `CONFLICT` lines). dev.ts does not start the stack while Redis cannot be reached
for the migration (12 tries over a minute, then exit 1; systemd restarts it). Inspection only (dry run, the password
expanded inside `sh -c`, never typed):
`sudo sh -c '. /usr/local/lib/bookrunner-deploy/.env.infra; REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:63790/1" exec sudo --preserve-env=REDIS_URL -u bookrunner HOME=/opt/bookrunner /opt/bookrunner/app/node_modules/.bin/bun /opt/bookrunner/app/scripts/bus-migrate.ts --ns testnet'`
(root only reads its own `.env.infra`; bun runs as the stack user).

### Rehearsal procedure (end to end)

| Step | Who | What | Done when |
|---|---|---|---|
| R1 | operator | Readiness, read-only (step 0): `bun scripts/orderly-readiness.ts --stage venue` | exit 0 (Orderly enabled USDG + broker `bookrunner` on the testnet vault, chain 46630 listed) |
| R2 | Orderly / admin wallet | Orderly side (step 2.1); builder admin key registered by the admin wallet (step 2.2) | readiness `--stage venue` 0; `--builder-key ed25519:<pub>` row `builder key` PASS |
| R3 | operator | Rehearsal env + funds (step 3.0): `/etc/bookrunner/testnet-live.env` (root 0600, one line per key) with a NEW mnemonic; the live deployer gets ETH (faucet) + the USDG budget (open question, VERIFY O17), the live gas funder ETH | the live deployer holds the launch budget |
| R4 | operator | Deploy: `sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh` (step 3.1; root-owned wrapper, bun / scripts as bookrunner) | `46630.live.json` written, `orderly.venue = "live"`; readiness `record orderly` PASS |
| R5 | operator (root) | `systemctl start bookrunner@testnet-live` (step 3.6); the public stack keeps running | `[dev] venue: LIVE Orderly testnet` in `.data/testnet-live/dev.log`; the launch charters NVDA / TSLA (rehearsal sizes, step 3.3) |
| R6 | operator | Per book: delegate signer (step 3.4), native deposit fee if any (step 3.5) | ops-venue `Orderly delegate signer confirmed` x2 per book, `book venue provisioned` |
| R7 | admin (Orderly One) | List `PERP_NVDA_USDC_bookrunner` / `PERP_TSLA_USDC_bookrunner` (step 2.3), assign each market's IF account (step 2.4) | readiness `symbol` rows listed; `venue_listing_pending` clears |
| R8 | operator | Windows close: IF + MM deposited on the real vault; verify (step 4) | `orderly-readiness.ts --api http://127.0.0.1:4500` exits 0 (books: IF funded > 100 USDG on the Orderly IF account); first mark reconciles |
| R9 | operator | Rollback / stop (step 5) whenever needed | `systemctl stop bookrunner@testnet-live`; the public stack never stopped |

### 0. Readiness check (read-only; run first and after every step)

```bash
bun scripts/orderly-readiness.ts                      # testnet; --mainnet for 4663; --json for machines
bun scripts/orderly-readiness.ts --stage venue        # exit 0 = Orderly has enabled the chain / token / broker
bun scripts/orderly-readiness.ts --builder-key ed25519:<public key>   # also: that key is registered for the admin account
bun scripts/orderly-readiness.ts --deployment contracts/deployments/46630.json   # the mock stack's record instead
```

It reads (eth_call / public GET only): the Orderly Vault's code, `getAllowedToken(keccak256("USDG"))` (must be the
testnet USDG `0x7E95…802F`), `getAllowedBroker(keccak256("bookrunner"))`, the chain in `/v1/public/chain_info` (with
this vault and `bookrunner` in its `broker_ids`), USDG for the chain in `/v1/public/token` (6 decimals, same
contract) and USDG's on-chain `decimals()` (stage **venue**); the broker in `/v1/public/broker/name`, the admin
wallet's account (`/v1/get_account`), our builder symbols `PERP_NVDA_USDC_bookrunner` / `PERP_TSLA_USDC_bookrunner`
in `/v1/public/info` and the equity markets already listed (stage **builder**); and, from the deployment record
(testnet default: `contracts/deployments/46630.live.json` when it exists, else `46630.json`; `--deployment`
overrides; skipped when absent), `config.usdc()`, `config.orderlyVault()`, the factory's OrderlyAdapter implementation
hashes, the record's `orderly` block (`record orderly`: venue live, this vault, USDG, broker `bookrunner`, consistent
with `contracts`) and, per Orderly book, the adapter's vault (mock or real), token and hashes, Orderly accounts (v3;
the builder IF EOA when bound) and, on the real vault, **`IF funded`**: the adapter's insurance (last venue report +
flows; with `--api http://127.0.0.1:4500` the Orderly IF account's equity from ops-venue's signed venue report instead,
as Orderly has no public per-account read: `/v1/public/insurancefund` is Orderly's own IF) strictly above 100 USDG
(FAIL once the book is Live / Retiring, INFO before its window closes); on the mock
vault the row is `empty` (migration precondition) instead (stage **books**). Exit 0 only when every row of the
selected stages passes (FAIL gates; WARN / INFO / SKIP do not); 1 = not ready; 2 = usage error.

Cron (testnet host, `bookrunner` user; read-only, outbound HTTPS only): poll the venue stage and keep the last
result, so the day Orderly enables the chain shows up without anyone re-running it:

```cron
*/30 * * * * cd /opt/bookrunner/app && ./node_modules/.bin/bun scripts/orderly-readiness.ts --stage venue --json > .data/testnet/orderly-readiness.json 2>&1; echo "$(date -u +\%FT\%TZ) exit=$?" >> .data/testnet/orderly-readiness.log
```

There is no alerts rule: exit 0 of `--stage venue` (`"ready": true` in the JSON) is the signal; it does not page.

Findings 2026-10-18 (testnet, re-run in Task 5): vault code PASS; `getAllowedToken` is 0x0 for USDG and for USDC;
`getAllowedBroker("bookrunner")` false (`orderly`, `woofi_pro`, `mythos` true); chain 46630 absent from
`chain_info`, USDG absent from `/v1/public/token`; broker `bookrunner` and the admin account `0xaa04…2e5c` exist; no
`_bookrunner` symbol; the only equity market is Orderly's own `PERP_TSLA_USDC`; with the mock record every books row
FAILs (books 1 and 2 on the mock vault, mock USDC, pre-v3 adapter implementation (devnet account ids), IF 30,000 + MM
~137,000-140,000 venue-side each). VERIFY O1-O3, O7, O14, O17.

### 1. What the rehearsal is (and why books 1 and 2 are not moved)

- Every OrderlyAdapter stores the Orderly vault, the settlement token and its broker / token hashes at
  `initialize`; no function changes them, and `UpgradeOrderlyAdapters.s.sol` keeps them for existing proxies.
- The protocol settles in ONE token, `config.usdc()`, cached at construction by every book component
  (UnderwritingVault, tranches, RevenueRouter, desk) and by BkrnFeeRouter, Backstop and the PoolEngine (immutable):
  there is no mixed-token design. The real vault only takes the token `getAllowedToken(keccak256("USDG"))` returns:
  testnet USDG. **Decision (Task 5): on the live venue everything settles in testnet USDG, the RHX5 PoolEngine book
  included**; RHX5 is not launched in the rehearsal by default (its PoolEngine `venueMinIf` is 10,000 USDG and
  trader-sim, which mints mock USDC, does not run there): `LAUNCH_BOOKS=NVDA,TSLA,RHX5` adds it.
- Books 1 and 2 hold balances venue-side (mock), so even the account migration (`migrateToOrderlyAccounts`, empty
  adapters only) is refused for them.

So the rehearsal is **a fresh deployment whose `config.usdc()` is testnet USDG and whose `config.orderlyVault()` is
the Orderly testnet vault (`Deploy.s.sol` with `DEPLOY_ORDERLY_VAULT` / `DEPLOY_SETTLEMENT_TOKEN`, no MockOrderlyVault
and no mock settlement token), NVDA and TSLA chartered on it (Orderly symbols `PERP_<T>_USDC_bookrunner`)**. Books 1
and 2 stay on the mock stack; retire them there (Operations "Wind-down") only when the mock stack is decommissioned.

### 2. Orderly side (Orderly, then the builder admin in Orderly One)

1. **Orderly** (request through the builder channel; nothing we can do on-chain): allow USDG
   `0x7E955252E15c84f5768B83c41a71F9eba181802F` and broker `bookrunner` on the Robinhood testnet Vault
   `0x2A5b650A894409372DDeE241EDAC92d4152bE24d`, and list chain 46630 in `chain_info` / `token`. Done when
   `orderly-readiness.ts --stage venue` exits 0. Also ask where testnet USDG for the rehearsal comes from (VERIFY O17).
2. **Builder admin key** (G6, one-time; admin wallet `0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9`, which the system
   never holds). The broker's admin account is that wallet's Orderly account
   `0xaa04410b18eb0856e02832221f24b2cd37fde7c6f6f8eec83fe95a2f62702e5c` (builder row `admin account`, registered).
   ops-venue acts as the builder through an Orderly key of that account:
   1. On a trusted machine, generate an ed25519 key pair (Orderly One "API keys" does it in the browser; or any ed25519
      tool: keep the base58 32-byte secret, the public key is `ed25519:<base58 public key>`).
   2. The admin wallet registers it for broker `bookrunner` on the testnet: Orderly One (connected with the admin wallet,
      network testnet) "API keys" -> add, or `POST https://testnet-api.orderly.org/v1/orderly_key` with the EIP-712
      `AddOrderlyKey` message signed by the admin wallet (`brokerId bookrunner`, `chainId 46630`, `orderlyKey`, `scope
      read,trading,asset`, `timestamp`, `expiration` <= 365 days). Note its expiry: re-register before it lapses.
   3. Hand the base58 secret to the operator out of band; it goes into `/etc/bookrunner/testnet-live.env` (server) as `ORDERLY_BUILDER_KEY_SECRET`
      (mode 600, never in git or logs). With the secret set ops-venue treats the key as registered and never generates
      or registers one (`loadOrCreateBuilderKey`); with an admin-owned `ORDERLY_BUILDER_ACCOUNT_ID` and no secret
      ops-venue refuses to start (`resolveBuilderAccount`), and so does dev.ts's live profile.
   4. Check: `bun scripts/orderly-readiness.ts --builder-key ed25519:<public key>` (row `builder key` PASS, expiry shown).
   **Builder fees are swept manually**: the builder fee withdrawal is an EIP-712 `Withdraw` only the account owner (the
   admin wallet) can sign, so ops-venue's automated sweep is OFF for an admin-owned builder account whatever
   `OPS_FEE_SWEEP_AUTO` says (logged once; the live testnet profile pins `OPS_FEE_SWEEP_AUTO=false`), and the
   `sweep_fees` job is refused (it would earmark on-chain, then fail at the withdrawal). Builder fees accrue on the
   admin account; settling them into the books (admin withdrawal to its wallet, then per book `adapter.sweepFees`
   earmark + transfer + `forwardPendingFees`) is a manual, not yet scripted step: on the testnet rehearsal leave them on
   the builder account (VERIFY O21; mainnet: decide who owns the builder admin account, O11).
3. **List the markets** (Perp Anything): `PERP_NVDA_USDC_bookrunner` and `PERP_TSLA_USDC_bookrunner` (Orderly appends
   the broker id to builder symbols, VERIFY O14), market session 24/5 (RWA). Index price source: our
   builder-pushed oracle feed `ORACLE_bookrunner` (`base_ccy` NVDA / TSLA; pushed by ops-venue, G2 / O18). Testnet prices are
   synthetic (no testnet Chainlink feeds, VERIFY C4): do not mix our feed with real-market sources on testnet, or the
   index and our marks diverge. With `ORDERLY_LISTING_MODE=manual` (the live default) ops-venue only waits for each
   listing (alert `venue_listing_pending`, `/health` `orderlyListing`) and picks it up within 5 minutes once the market
   shows on `GET /v1/public/info/PERP_<T>_USDC_bookrunner` with a launched status; in POST_ONLY the agent quotes
   maker-only to build the launch depth (`AGENT_VENUE_POST_ONLY_QUOTE`), then normally once it is ACTIVE.
4. **IF accounts** (G5, VERIFY O10): each symbol is assigned to exactly one IF account in Orderly One, funded strictly
   above 100 USDG per effective symbol on testnet (25,000 on mainnet). The book funds its IF account itself at window
   close (`depositToVenue(IF)` = `Vault.depositTo(owner, …)`, event `OrderlyDeposit(0, accountId, amount, fee)`), so the
   charter's `ifTargetUsd >= venueMinIf` (testnet 101 USDG, step 3.1) covers the requirement. One IF account per book:
   do not assign two markets to one account (the adapter reports the account's whole equity as that book's insurance).
   Two models, chosen with `ORDERLY_IF_MODE` (ops-venue) and the adapter's on-chain binding, which must agree (else
   alert `venue_if_account` and no IF provisioning for that book; other books are unaffected):
   - **contract** (default; needs Orderly to accept a contract / delegate account as a market's IF account, VERIFY
     O10 open): the IF account is the book's `OrderlyIFAccount` (`adapter.accountId(0)`, owner `adapter.ifAccount()`).
     It exists once the book is created and its delegate signer confirmed (step 3.4). Admin in Orderly One: when
     listing the market (step 2.3) pick that account (`adapter.accountId(0)`) as the market's IF account. Withdrawals
     are automatic (ops-venue, delegate signer).
   - **builder** (FALLBACK only, if Orderly refuses a contract account; **not for mainnet without the owner's explicit
     sign-off**: ops-venue and the mainnet preflight refuse it on 4663 unless `ORDERLY_IF_MODE_BUILDER_ACK=1`): the IF
     account is the Orderly account of an operator EOA (one EOA per book: Orderly derives one account per wallet and
     broker). An EOA is a single private key: the multisig / timelock controls only the binding
     (`setIfAccountOwner`), never the EOA, so the book's IF safety equals that key's custody. Use a fresh EOA whose
     Orderly account holds nothing (equity found there before the book's IF deposit makes ops-venue refuse the book's
     reports: alert `venue_if_account` prior_equity).
     Operator, per book: (a) register the EOA with Orderly for broker `bookrunner` (Orderly One / `POST
     /v1/register_account` signed by the EOA); its account id is `keccak256(abi.encode(eoa, keccak256("bookrunner")))`;
     (b) the timelock calls `adapter.setIfAccountOwner(eoa)` while the book's IF is empty (before the window
     closes; refused once IF capital or an IF withdrawal is on the adapter); (c) add `<bookId>=<accountId>` to
     `ORDERLY_IF_BUILDER_ACCOUNTS` and set `ORDERLY_IF_MODE=builder` in `/etc/bookrunner/testnet-live.env` (step 3.6), restart the stack; (d) register the
     Orderly key ops-venue logs (`builder IF account: the operator must register this Orderly key`, scope `read`)
     for that account from the EOA (Orderly One or `POST /v1/orderly_key` signed by the EOA): until then the book's
     venue reports fail (alert `venue_if_account` key_pending). Admin in Orderly One: assign that account as the
     market's IF account (step 2.3). IF withdrawals (recall / retirement): ops-venue cannot sign for the EOA, so the
     operator withdraws the requested amount on Orderly (paid to the EOA; delist first on a retiring book), then
     transfers it to the adapter: ONE plain USDG transfer of at least the requested amount (top up Orderly's withdrawal
     fee), from the EOA. ops-venue recognises the withdrawal, confirms it on-chain, tracks that Transfer log (never the
     adapter's balance) and sweeps (alert `venue_if_operator_pending`, critical after 6 h; published from the on-chain
     confirmation until the funds are back or written off, whether or not ops-venue can read the account). Withdraw
     promptly: while the on-chain request is still Requested, and until Orderly shows the withdrawal COMPLETED, the
     book's venue reports are held (a withdrawal Orderly fails and credits back must not be counted twice); the
     return-wait after COMPLETED does not hold them. A payout not back on the adapter within
     `OPS_IF_RETURN_WRITE_OFF_MS` (24 h, at least the adapter's 1 h floor) of its ON-CHAIN confirmation is written off
     from NAV on-chain, independent of any Orderly read (a removed key, Orderly down or a missing history row never
     stops it; errors there burn no saga attempt) (`adapter.writeOffOperatorPayout`, the vault's
     flowNonce bumps; alert critical "WRITTEN OFF"); returned later it is swept to the vault as a gain. Misuse
     detection: any withdraw saga that FAILS pages (`venue_withdraw_failed`, critical for IF); any withdrawal from the
     builder IF account that no on-chain request asked for pages critical
     (`venue_if_unadopted_withdrawal`; acknowledge reviewed ids with `OPS_IF_WITHDRAW_ACK`), and so does an IF equity
     below the adapter's insurance with no on-chain flow (`venue_if_equity_drop`). This moves IF custody off the
     adapter to that key: every deposit is still on-chain (`OrderlyDeposit`), every return a transfer to the adapter.
   - **Switching an IF account after the book was listed** (either direction, only while its IF is empty): ops-venue
     picks the new binding up within `OPS_IF_BINDING_RECHECK_MS` (5 min), re-provisions the book, removes the previous
     IF account's ops key from Orderly and publishes `venue_if_account` reassign: the admin must **re-assign the
     market's IF account in Orderly One** to the new account (api mode too: `createSymbol` does not change it), then
     check it with the `fund_if` job (the market's IF balance strictly above the requirement).
   - **Never switch the IF mode (`ORDERLY_IF_MODE`, or the adapter's `setIfAccountOwner` binding) while an IF payout
     is in transit**: no IF withdraw saga of the book may be open (requested, adopted, confirmed and not yet swept, or
     written off and not yet returned; `ifOperatorWaits` / alert `venue_if_operator_pending` empty for the book). The
     adapter refuses `setIfAccountOwner` while an IF withdrawal is on it, but a changed ops-venue mode would orphan a
     builder-mode payout still in the operator's wallet (the return is only tracked in builder mode).

### 3. Operator side (testnet: the deployer is `config.timelock()`)

0. **Rehearsal env, budget and testnet USDG.** On the server the live secrets live in ONE root-owned file,
   `/etc/bookrunner/testnet-live.env` (root:root 0600): the unit reads it (EnvironmentFile) and `rehearsal-deploy.sh`
   parses it (step 3.1); an `.env.testnet-live` in the app tree is refused there (it is for a developer machine only).
   Exactly ONE line per key: every reader (systemd, `dev.ts`, `deploy-testnet.sh`, the wrapper) refuses a file defining a
   key twice (`scripts/env-file.ts`; append-with-`>>` mistakes would otherwise make readers disagree). As root:
   ```bash
   BKRN_TESTNET_LIVE_MNEMONIC=<a NEW 12/24-word mnemonic, generated offline; never the public stack's>
   ORACLE_SEED=<openssl rand -hex 32>
   ORDERLY_BUILDER_KEY_SECRET=<base58 secret of the builder admin key, step 2.2>
   # optional: RHC_TESTNET_RPC_URL (and FORGE_RPC_URL for forge only), MARK_INTERVAL_SECONDS, ANTHROPIC_API_KEY (charter jury),
   # ALERT_* delivery (its mails say "BookRunner testnet-live"), the DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN /
   # DEPLOY_ORDERLY_TOKEN / DEPLOY_ORDERLY_BROKER_ID / DEPLOY_CHARTER_FEE_USD overrides of step 3.1
   ```
   (`sudo install -m 0600 -o root -g root /dev/null /etc/bookrunner/testnet-live.env`, then edit it as root.)
   Keep an offline copy (it is not in the backups, RESTORE.md). Funds (VERIFY O17: the source of testnet USDG is an open
   question to Orderly / Paxos; there is no faucet we know of): the live deployer (index 0 of the NEW mnemonic; its address
   is printed by `deploy-testnet.sh`) needs ETH (faucet) for the deployment and the launch's gas distribution, and, before
   the launch, per Orderly book the charter fee (`DEPLOY_CHARTER_FEE_USD`, 10 USDG by default on the live venue) + 132% of
   its raise (IF + MM: sponsor 12%, allocators 30% / 50% / 40%, the senior tranche oversubscribed as on devnet), i.e.
   2 x (10 + 858) = **1,736 USDG** for NVDA + TSLA at the rehearsal sizes (IF 150 > 100 required, MM 500; whole-USD
   overrides `LAUNCH_IF_USD` / `LAUNCH_MM_USD` / `LAUNCH_MAX_INVENTORY_USD`, `scripts/launch-plan.ts`). The live **gas
   funder** (index 23 of the new mnemonic, or its own `BKRN_TESTNET_FUNDER_PK`) tops the live role keys up (gas-keeper)
   and needs its own testnet ETH (faucet); the public stack's funder never pays for the rehearsal. The launch transfers
   each participant's share from the deployer and refuses up front when it holds less. Optional: USDG on the
   MockSwapRouter (`transfer(swapRouter, x)`; the owner's `withdraw` takes it back) if hedge SELLS must fill: the router
   cannot mint the real token (hedge buys still mint the mock Stock Tokens); without it a hedge sell reverts
   `InsufficientLiquidity`.
1. **Deployment with the real externals** (G1). On the server, from the root-owned deploy copy (like `update.sh`):
   ```bash
   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh                    # first deployment
   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh --redeploy [--force-archive]
   ```
   (on a developer machine with Docker: `ORDERLY_VENUE=live bash scripts/deploy-testnet.sh`, every step in-process).
   **Who runs what** (HARDENING.md: root runs only root-owned code): the wrapper parses the root-owned
   `/etc/bookrunner/testnet-live.env` (duplicates refused, every value validated, mode 0600 required) and the root-only
   `.env.infra`, and runs every bun / script step AS the `bookrunner` user (`scripts/deploy-testnet.sh --phase check |
   archive-files | migrate | finish`) with THOSE values in its environment (`sudo --preserve-env`, never on a command
   line): the check phase, forge and the finish phase therefore use the same mnemonic and the same `DEPLOY_*` settings
   (read once by the wrapper; the plan records them and the wrapper refuses a plan that differs). Root itself only
   drives Docker: the database (create, `pg_dump` of an archived one, rename) and the live Redis (PING, SAVE, FLUSHDB)
   through `docker exec` on the infra containers, and forge in the pinned Foundry image (by digest, `FOUNDRY_IMAGE`)
   run as the bookrunner uid (`--cap-drop ALL`, no-new-privileges, no Docker socket; `--mount type=bind`: the app tree
   READ-ONLY, only `contracts/{out,cache,broadcast,deployments}` and `/opt/bookrunner/.foundry-docker` writable, each
   source re-checked as a real bookrunner-owned directory right before the run; the RPC URL as `ETH_RPC_URL`, not argv).
   Residual: forge compiles and runs the Solidity deploy script from the app tree inside that unprivileged container,
   which can write only those bookrunner-owned paths. The only app-tree file root reads is the check phase's plan (fixed
   keys, validated, symlink refused). Every file created in the app tree is the bookrunner user's (dumps through
   `sudo -u bookrunner dd`, forge output as its uid); the wrapper refuses while `contracts/{out,cache,broadcast,
   deployments}` hold files from an earlier root run (it prints the one-off `chown -R --no-dereference`).
   `scripts/deploy-testnet.sh` itself refuses to run as root from the app tree. **Broadcast check:** the finish phase
   refuses (exit 4) a deployment whose broadcast transactions were not ALL sent by the plan's deployer (and a mnemonic
   that does not derive it): never start the stack on such a record.
   It uses the live mnemonic (and `.env.testnet` only to compare the deployer addresses: refused when they match),
   runs `orderly-readiness.ts --stage venue` (exit 5 = Orderly not ready: nothing deployed), creates and migrates the
   `bookrunner_testnet_live` database, and runs `Deploy.s.sol` with the live mnemonic and `DEPLOY_ORDERLY_VAULT=0x2A5b…E24d`,
   `DEPLOY_SETTLEMENT_TOKEN=0x7E95…802F` (USDG), `DEPLOY_ORDERLY_TOKEN=USDG`, `DEPLOY_ORDERLY_BROKER_ID=bookrunner`,
   `DEPLOY_CHARTER_FEE_USD=10000000` and `DEPLOY_OUT=deployments/46630.live.json` (each overridable). `Deploy.s.sol`
   refuses before any broadcast unless the token has code and 6 decimals, `getAllowedToken(keccak256("USDG"))` returns
   it and `getAllowedBroker(keccak256("bookrunner"))` is true; it deploys no MockOrderlyVault and no mock settlement
   token (`config.usdc()` = `contracts.usdc` = `contracts.usdg` = USDG; the swap router never mints it), keeps the mock
   Stock Tokens / router / synthetic oracle prices, sets `venueMinIf[Orderly]` to 101 USDG, and writes the record with
   `"orderly": {"venue": "live", "vault", "brokerId", "token": "USDG", "settlementToken"}`. The script then checks
   `config.usdc()` / `config.orderlyVault()` on-chain. A fresh deployment has v4 adapters (Orderly accounts: no
   migration). The public stack's `46630.json` is not touched. Mainnet: `DeployMainnet` input
   `params.venueMinIfOrderly` > 25,000e6.
   **Redeploying** (`REDEPLOY=1`) is refused unless every book of the existing `46630.live.json` (including an unfinished
   launch's) is Retired or Cancelled with an empty adapter (`scripts/rehearsal-guard.ts`, read-only; exit 6 otherwise):
   those books' Orderly accounts may hold real USDG, and the record plus `.data/testnet-live/keys` are the way back to
   them. `FORCE_ARCHIVE=1` overrides with a loud warning. It is also refused while `bookrunner@testnet-live` runs
   (systemd, and a fresh testnet-live supervisor status: `rehearsal-guard.ts --supervisor`), and nothing is archived
   before the readiness gate passes. Then the old record is archived as `46630.live.<UTC stamp>.json`, the state as
   `.data/testnet-live.<stamp>` (keys kept) with `postgres.dump` (the old database) and `redis-live.rdb` (the old live
   Redis) inside it, the database renamed to `bookrunner_testnet_live_<stamp>` and the live Redis db 0 emptied; nothing
   is deleted. The archived directory is in every daily backup until removed by hand (RESTORE.md retention).
   A redeploy refuses (exit 8, nothing archived) when `redis-live` does not answer `PING` with `REDIS_LIVE_PASSWORD`
   (the wrapper reads it from `.env.infra`; `update.sh` / `install.sh` create it), and stops loudly (exit 8) if
   snapshotting or emptying it fails. **Order of a redeploy:** checks + readiness gate (stack user) -> root checks (unit
   stopped, Redis password, no root-owned build files) -> archive (record copied, state moved, DB dumped + renamed, live
   Redis snapshotted + emptied) -> new DB + migrations -> forge -> finish. A forge failure after the archive leaves the
   OLD record in place (it is copied, not moved) next to a moved state, renamed DB and empty live Redis: recoverable
   either way: re-run with `--redeploy` (the old record's books are archived again under a new stamp), or restore the
   old stack from `.data/testnet-live.<stamp>` (move it back, `ALTER DATABASE bookrunner_testnet_live_<stamp> RENAME TO
   bookrunner_testnet_live`, load its `redis-live.rdb` as in RESTORE.md step 4).
2. **`UpgradeOrderlyAdapters.s.sol`** is not part of the rehearsal (the live deployment already has the current
   implementation). **Never run it on the mock stack with `DEPLOY_ORDERLY_TOKEN=USDG`**: the mock vault only allows
   `keccak256("USDC")`, so every new Orderly book would revert `TokenNotAllowedByVenue` at `initialize`, and books 1 and 2
   are skipped by the migration (not empty).
3. **Charter NVDA and TSLA**: the first start of `bookrunner@testnet-live` (step 6) finds no books in `46630.live.json`
   and runs `scripts/launch-devnet.ts` once: charter symbols `PERP_NVDA_USDC` / `PERP_TSLA_USDC`
   (the services trade `PERP_<T>_USDC_bookrunner`, G3), IF 150 / MM 500 / max inventory 250 USDG per book (raised to
   `venueMinIf` if lower), funded by transfer from the deployer, books appended to the record. `LAUNCH_BOOKS` picks the
   books (default NVDA,TSLA on the live venue). The launch **resumes** instead of starting over: each chartered book is
   recorded at once in the record's `launch.launched` (`launch.complete: false` until every window is closed, then the
   books move to `books`), and a book it stopped in the middle of is picked up from its charter (same symbol and sponsor,
   Filed or Approved: no second charter fee; votes, subscriptions and the desk key are skipped when already done). dev.ts
   re-runs the launch at its next start while `launch.complete` is false (`systemctl restart bookrunner@testnet-live`).
   `dev.ts --no-launch` skips it (charter by hand, then `scripts/record-books.ts --file contracts/deployments/46630.live.json`).
4. **Delegate signer, per new Orderly book**: `adapter.setDelegateSigner(<OPS_VENUE address>)` registers the ops-venue
   EOA on the vault for the adapter (MM account) and its OrderlyIFAccount (IF account) and emits `AccountDelegate`.
   ops-venue in live mode then, per contract: finds that log on the record's `orderlyVault` from `startBlock`, gets
   `GET /v1/registration_nonce`, signs EIP-712 `DelegateSigner` with the ops-venue key and posts
   `POST /v1/delegate_signer` (this creates the contract's Orderly account). It then generates the book's ed25519
   keys in `OPS_KEYS_DIR` (`.data/testnet-live/keys`; MM trade key `read,trading`; IF / MM ops keys `read,asset`; TTL
   `OPS_TRADE_KEY_TTL_DAYS` 30 / `OPS_OPS_KEY_TTL_DAYS` 365) and registers each with `POST /v1/delegate_orderly_key`
   (EIP-712 `DelegateAddOrderlyKey`, `delegateContract` = the account's owner). The agent's OrderlyVenue loads the trade
   key from the same key store. Then step 2.4 (assign the IF account).
5. **Deposit fees**: the real vault may charge a native deposit fee (`adapter.depositNativeFee`): `fundNative` each
   adapter before the window closes, or set `OPS_NATIVE_TOPUP_MAX_WEI` (VERIFY O5).
6. **Services: the `bookrunner@testnet-live` unit** (G7). Installed by `install.sh` / `update.sh` (template +
   drop-in; `update.sh` restarts it after a deploy only if it is running), never enabled by them:
   ```bash
   sudo systemctl start bookrunner@testnet-live          # start (the public bookrunner.service keeps running)
   sudo systemctl enable bookrunner@testnet-live         # optional: keep it across reboots
   sudo systemctl stop bookrunner@testnet-live           # stop (state and record stay; restart resumes)
   sudo tail -f /opt/bookrunner/app/.data/testnet-live/dev.log
   curl -s http://127.0.0.1:4500/health; echo            # its API (loopback only)
   ```
   **Host memory check before the first start** (the caps add up; read the host's figure, do not guess):
   `grep MemTotal /proc/meminfo; free -h` on the host. Budget at the caps: public stack 2 G (high) / 2.5 G (max) + 2 G
   swap, rehearsal 1.5 G / 2 G + 1 G swap, Postgres 512 MB, Redis 128 MB + redis-live 64 MB, plus the mail services
   already on that VPS. Start the rehearsal only when `MemAvailable` (with the public stack running) is above ~2.5 G;
   otherwise lower `MemoryHigh` / `MemoryMax` in the drop-in (`systemctl edit bookrunner@testnet-live`) or wait.
   Locally the same is `bun scripts/dev.ts --network testnet-live` (with `.env.testnet-live`; `docker compose up -d`
   starts `redis-live` on 63791 too). The profile
   (`scripts/network-profile.ts` `testnetLiveProfile`) sets `ORDERLY_BASE_URL=https://testnet-api.orderly.org`,
   `ORDERLY_BROKER_ID=bookrunner` (venue symbols `PERP_<T>_USDC_bookrunner`), `ORDERLY_TOKEN=USDG`,
   `ORDERLY_LEDGER_ADDRESS=0x1826B75e2ef249173FC735149AE4B8e9ea10abff` (testnet Ledger, withdraw EIP-712 domain),
   `ORDERLY_BUILDER_ACCOUNT_ID=0xaa04…2e5c` (the admin account), `ORDERLY_LISTING_MODE=manual`, `ORDERLY_IF_MODE=contract`
   (each overridable from `/etc/bookrunner/testnet-live.env` / a local `.env.testnet-live`: e.g. `ORDERLY_IF_MODE=builder` + `ORDERLY_IF_BUILDER_ACCOUNTS`, step 2.4;
   `ORDERLY_ORACLE_WS_URL` defaults to `wss://testnet-ws-oracle.orderly.org`, undocumented, VERIFY O18) and pins
   `ORDERLY_MODE=live`, `OPS_FEE_SWEEP_AUTO=false`, the live mnemonic as the role mnemonic of its signing children,
   `DEPLOYMENT_FILE=contracts/deployments/46630.live.json`, the database `bookrunner_testnet_live`, its own Redis
   (`redis://:<REDIS_LIVE_PASSWORD>@127.0.0.1:63791/0`; `REDIS_LIVE_URL` overrides; refused when it is the public Redis
   or when the infra Redis has a password and `REDIS_LIVE_PASSWORD` is missing), the bus namespace `BKRN_BUS_NS=testnet-live`,
   `.data/testnet-live/{keys,ops-venue/sagas.json}`, ports `API_PORT=4500` / `ORACLE_PORT=4510` / `CHARTER_PORT=4530` (and
   the alerts probes on them), `ALERT_LABEL=BookRunner testnet-live (Orderly rehearsal)` and `ALERT_BACKUP_EXPECTED=0`
   (the daily backup covers both stacks and is recorded in the public stack's Redis db). It starts neither mock-orderly,
   trader-sim nor the web dev server, and refuses to start on any key problem above, a missing
   `ORDERLY_BUILDER_KEY_SECRET` or `ORACLE_SEED`, a missing record or one that is not a live-venue record on this vault /
   USDG / broker, a non-https `ORDERLY_BASE_URL`, or `OPS_FEE_SWEEP_AUTO` set to anything but false. ops-venue itself
   refuses an admin-owned builder account without the key secret. In live mode the oracle publishes its signed prices
   per venue symbol (`bkrn:testnet-live:oracle:venue-feed`) and ops-venue pushes them to the Builder Oracle WebSocket at >= 1/s in
   session (log `live builder price push started`, alert `builder_price_push`); the agent quotes maker-only (POST_ONLY)
   while the market is in its POST_ONLY launch phase.
   **Public access (optional, off by default).** nginx routes nothing to the rehearsal stack. To expose its API read-only,
   add a separate server block for a subdomain (e.g. `live.bookrunner.tech`, covered by the `*.bookrunner.tech` wildcard
   DNS) proxying `/trpc` + `/health` + `/v1` to `127.0.0.1:4500` with the same locations snippet and rate limits as the
   main site, a certificate for that name (`certbot --nginx -d live.bookrunner.tech`) and `WEB_ORIGIN` for it in
   `.env.testnet-live`; the operator app build (`apps/web`) points at the public API, so a rehearsal UI needs its own
   build (`VITE_API_URL`). Until then, use the API over ssh (`ssh -L 4500:127.0.0.1:4500 usecert-ubuntu`).

### 4. Verification

- `bun scripts/orderly-readiness.ts --api http://127.0.0.1:4500` exits 0 (all stages; the default record is
  `46630.live.json`; `--api`: the IF row reads the Orderly IF account through ops-venue's signed report).
- `.data/testnet-live/dev.log`: `[dev] venue: LIVE Orderly testnet (https://testnet-api.orderly.org, broker bookrunner,
  contracts/deployments/46630.live.json); API :4500; no mock-orderly / trader-sim / web`; bookrunner.tech (the public
  stack) unchanged: `curl -s http://127.0.0.1:4400/health`.
- ops-venue log: `ops-venue starting` with `mode: live` and the testnet base URL, the fee-sweep notice only if
  `OPS_FEE_SWEEP_AUTO` was left on, `builder account ready`, `Orderly delegate signer confirmed` (twice per book:
  adapter and OrderlyIFAccount), `book venue provisioned`, `ORDERLY_LISTING_MODE=manual`.
- `GET https://testnet-api.orderly.org/v1/get_account?address=<adapter>&broker_id=bookrunner&chain_type=EVM` returns
  `adapter.accountId(1)`; with `address=<adapter.accountOwner(0)>` (the OrderlyIFAccount, or the builder EOA in
  `ORDERLY_IF_MODE=builder`, where the delegate is confirmed once per book: the adapter only) it returns
  `adapter.accountId(0)`.
- After the window closes: `OrderlyDeposit` events for IF and MM on each adapter, the vault's USDG balance up by the
  deposits, the signed venue reports (Redis `bkrn:testnet-live:venue:report:<bookId>` on the live Redis; `GET 127.0.0.1:4500/v1/books/<id>/venue-report`) show IF and MM equal to the deposits,
  readiness `IF funded` PASS (> 100 USDG), the symbols turn `ACTIVE` (readiness `symbol` rows PASS), the agent quotes,
  and the first mark reconciles against Orderly's statement (Operations "Mark reconciliation break").

### 5. Stop / rollback

The public testnet stack is never involved: it keeps running throughout, so there is nothing to switch back.

1. Stop the rehearsal: `sudo systemctl stop bookrunner@testnet-live` (and `disable` if it was enabled). Its record,
   database, its Redis instance and `.data/testnet-live/` stay; a restart resumes where it stopped.
2. The live books keep their funds on Orderly's testnet while stopped (marks and reports pause). To recover the USDG,
   run the stack and retire them first (GUARDIAN `setNewBooksPaused(true)`, `MarketCharter.retire`; ops-venue recalls IF
   and MM, final mark, holders redeem; in Orderly One set the markets REDUCE_ONLY / delist as the IF withdrawal requires,
   alert `venue_delist_pending`). Builder IF mode: never leave an IF payout in transit when switching modes (step 2.4).
3. A failed or abandoned rehearsal deployment: `REDEPLOY=1` (step 3.1: refused while books are live or funded,
   `FORCE_ARCHIVE=1` to override; the old record / DB / state are archived, never deleted).
4. Backups and restore of the rehearsal state: deploy/server/RESTORE.md (last section).
5. `orderly-readiness.ts --deployment contracts/deployments/46630.json` still shows the public stack's books on the mock
   vault (FAIL expected there).

### Gaps between the rehearsal and the code (2026-10-18)

| # | Gap | VERIFY |
|---|---|---|
| G1 | **Closed in code (2026-10-18).** Hybrid deployment: `Deploy.s.sol` `DEPLOY_ORDERLY_VAULT` + `DEPLOY_SETTLEMENT_TOKEN` (both or neither; `getAllowedToken` / `getAllowedBroker` / 6 decimals checked before any broadcast; no MockOrderlyVault, no mock settlement token; mock Stock Tokens / router / prices kept; `orderly` record block; `DEPLOY_OUT`), `scripts/deploy-testnet.sh ORDERLY_VENUE=live` (readiness gate, own record / DB), `scripts/launch-devnet.ts` live funding by transfer at rehearsal sizes (`scripts/launch-plan.ts`). Protocol-wide settlement in testnet USDG (the PoolEngine too; RHX5 not launched by default). Still open: the **source of testnet USDG** (ask Orderly / Paxos). Adapters still cannot be rebound to another vault / token (by design). | O17 |
| G2 | **Closed in code (2026-10-18).** Builder-pushed index price: the oracle publishes its signed price per venue symbol every tick (`bkrn:<ns>:oracle:venue-feed`); ops-venue pushes it to the Builder Oracle WebSocket (`src/builderOracle`, documented auth / message / ping) every second in session, re-sending the latest signed price between oracle ticks (testnet: every 2 s) and stopping when the oracle holds (session closed) or has no fresh price (a held price older than 10 s / 3 ticks counts as no price); alert `builder_price_push` after 30 s (a market never listed on Orderly yet, G4: logged only), or when the push status is old or missing. The session in which the oracle holds follows the charter sessions: they must equal the Orderly One market session of each listing (step 2.3). Still to confirm with Orderly: the testnet host (default `wss://testnet-ws-oracle.orderly.org`, undocumented), the auth / reject message shapes, and whether the builder account (vs the admin account, G6) may push `ORACLE_bookrunner`. | O18 |
| G3 | **Closed (2026-10-18).** Symbol naming: one mapping (`packages/shared/src/venueSymbol.ts`) used by ops-venue, the agent and risk: `ORDERLY_MODE=live` -> `PERP_<T>_USDC_<ORDERLY_BROKER_ID>` (`PERP_NVDA_USDC_bookrunner`), mock -> the charter symbol verbatim. Charters, marks and the UI keep `PERP_NVDA_USDC`. Charters with a symbol no Orderly market can carry are rejected at filing (API) and blocked by the jury; a live book without a market is tracked for reports / withdrawals only (alert `venue_symbol_unmapped`). | O19 |
| G4 | **Closed in code (2026-10-18).** `ORDERLY_LISTING_MODE=manual` (default with `ORDERLY_MODE=live`; `api` stays the default in mock mode): the admin lists each market in Orderly One (step 2.3); ops-venue never calls a listing or symbol-status endpoint, provisions the book's accounts and keys and follows `GET /v1/public/info/{symbol}` per symbol (15 s doubling to 5 min, 5 s timeout, 4 at once: a book waiting for its listing never holds up another). State per symbol (awaiting / listed / missing, open for new risk or restricted) in `bkrn:<ns>:ops-venue:symbol-issues` and the API's `/health` `orderlyListing`. Alerts: `venue_listing_pending` (warning; critical after a Live book has had no market for 30 min), `venue_market_restricted` (REDUCE_ONLY / POST_ONLY warning, DELISTING / DELISTED on a Live book critical), `venue_market_missing` (a listed market gone: Live critical), `venue_listing_check` (5 failed checks), `venue_delist_pending`. The agent quotes and hedges reduce-only while its market is not open (`AGENT_VENUE_MARKET_GATE`); in Orderly's POST_ONLY launch phase it quotes both sides maker-only (POST_ONLY orders within the mandate) to provide the launch depth (`AGENT_VENUE_POST_ONLY_QUOTE`, default true with `ORDERLY_MODE=live`; false = reduce-only); the builder price push pages for a listed market that went missing or restricted. Retirement: set the market REDUCE_ONLY in Orderly One if needed and delist it there when the IF withdrawal of a retiring book waits on it (alert `venue_delist_pending`; ops-venue retries every minute, 24 h ceiling). | O20 |
| G5 | **Closed in code (2026-10-18)**; Orderly's answer still open. IF account mode: `ORDERLY_IF_MODE=contract` (default, the per-book OrderlyIFAccount delegate account) or `builder` (FALLBACK, not for mainnet without the owner's sign-off, `ORDERLY_IF_MODE_BUILDER_ACK=1`; return tracking per Transfer log, write-off from NAV after 24 h, unadopted-withdrawal and IF-drop alerts: step 2.4; an operator EOA's Orderly account bound by the timelock's `adapter.setIfAccountOwner(eoa)` (OrderlyAdapter v4), listed per book in `ORDERLY_IF_BUILDER_ACCOUNTS`; deposits unchanged on-chain via `Vault.depositTo(eoa, …)`; the operator registers ops-venue's IF key and performs IF withdrawals, returning the USDG to the adapter, ops-venue confirms and sweeps). Mode / binding mismatch: alert `venue_if_account`, no IF provisioning for that book only. Admin clicks per mode: step 2.4. `venueMinIf[Orderly]` per network in `Deploy.s.sol` (testnet 101 USDG). Still to ask Orderly: may a contract (delegate) account be a market's IF account? | O10 |
| G6 | **Closed in code (2026-10-18).** Builder admin key: the admin wallet registers an Orderly key for its account once (step 2.2) and the operator sets `ORDERLY_BUILDER_KEY_SECRET`; ops-venue refuses an admin-owned `ORDERLY_BUILDER_ACCOUNT_ID` in live mode without it, turns its automated fee sweep off and refuses the `sweep_fees` job (the fee withdrawal needs the admin wallet's signature). Builder fee settlement into the books stays manual (not scripted). | O21 |
| G7 | **Closed in code (2026-10-18).** dev.ts `--network testnet-live` / unit `bookrunner@testnet-live` (step 3.6): a separate stack next to the public testnet one (own mnemonic, record, DB, Redis instance, bus namespace, state, ports; key-separation preflight, cross-namespace message drop and supervisor guard), live Orderly testnet values, no mock-orderly / trader-sim / web. The public stack stays on the mock venue. | O22 |
| G8 | Orderly's testnet itself: chain 46630 in `chain_info`, USDG and the broker allowed on the vault (Orderly action). | O1-O3, O7 |
