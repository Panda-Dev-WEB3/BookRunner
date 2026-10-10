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
3. TEE attestation for the oracle signer verified and registered ("Oracle signer attestation" below);
   `source-check` green against a mainnet RPC ("Real prices" below).

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
   - `BkrnFeeRouter.setBuybackParams(poolFee, refBkrnPerUsdcWad, maxSlippageBps, maxPerCall)` with the
     VERIFY-ed SwapRouter02 BKRN/USDC fee tier, a reference price near market (or
     `setBkrnPriceId` once the oracle prices BKRN) and a per-call cap;
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
   - `BkrnFeeRouter.buybackRouter()` is the real SwapRouter02 (never MockSwapRouter) and
     `buybackPoolFee()` / `refBkrnPerUsdcWad()` (or `bkrnPriceId()`) / `maxSlippageBps()` /
     `maxBuybackPerCall()` are set; `BkrnStaking.cooldown() >= 1 day` and `rewardsDuration()` set;
   - the deployer holds no BKRN allocation and owns no contract (`Ownable` mocks are never deployed).

   Testnet (46630) keeps the deployer as `config.timelock()` (0s delay) on purpose: the post-
   conditions above apply to mainnet only, except that the testnet treasury is devkeys index 22,
   not the deployer.
3. Grant roles: MARK_SIGNER, RISK, OPS_VENUE, JURY, KEEPER to service keys held in a secret manager
   (never the test mnemonic; `devkeys.ts` refuses non-local chains without explicit keys).
4. Register oracle signer(s) through the attestation flow below; register Stock Tokens (below) and
   indices with float caps; set venue minimum IF per venue; set agent tier bonds.
5. Seat the three committee members; each calls `bond()`.
6. Charter the three launch books (NVDA, TSLA, Stock-Token index) from the studio treasury
   (sponsor), committee approves, subscription windows open at launch, first marks the same day.

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
