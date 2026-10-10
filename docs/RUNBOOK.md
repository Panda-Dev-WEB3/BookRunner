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
The oracle divides per-token feeds by that same on-chain value before the median
(`packages/shared/src/stockTokens.ts`). Never configure an HTTP source that quotes the Stock Token
price: every non-Chainlink source must be a per-share US-equity price.

1. **Source check** (read-only, before anything is registered and again before launch):
   `bun run --cwd services/oracle source-check --chain 4663 --rpc $RHC_RPC_URL [--registry 0x<registry>]`
   reads every feed and token in `config/chains/4663.json` (proxy code, `decimals()`, `description()`,
   `latestRoundData()` age vs heartbeat in session, token code / `decimals() == 18` / `uiMultiplier()` /
   `oraclePaused()` / pending multiplier, per-share price, the HTTP sources from `ORACLE_HTTP_SOURCES`
   against Chainlink, the mainnet production rules of the current `ORACLE_*` environment, and with
   `--registry` the registration + live-multiplier mode). Exit code 1 on any FAIL; fix every FAIL.
2. **Stock Tokens** (timelock, per token of `config/chains/4663.json`):
   `register(token, bytes32(<TICKER>), <current uiMultiplier()>, floatCapRaw)` then
   `setMultiplierSource(token, true)`. The stored value is the anchor; the live multiplier may drift
   `multiplierBandBps` (default 500 = 5%) from it before valuations fail closed.
3. **Oracle environment** (`services/oracle`, chain 4663): `ORACLE_SYNTHETIC=0`, `SESSIONS_MODE=charter`,
   `ORACLE_MIN_SOURCES>=2` (the service also applies `AttestedOracle.minSources()`, default 3),
   `ORACLE_CHAINLINK_RPC_URL` (or `RPC_URL`), at least one licensed per-share source in
   `ORACLE_HTTP_SOURCES`, `ORACLE_ATTESTATION_FILE`. The service refuses to start on 4663 when any
   production rule fails (`services/oracle/src/production.ts`) and never signs a price, held or not, with
   fewer than the minimum sources. Synthetic sources cannot be constructed on 4663.

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
  the oracle drops the Chainlink observation for that ticker (the other sources keep the price, or
  nothing is signed below the minimum and consumers see a stale price: reduce-only).

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
