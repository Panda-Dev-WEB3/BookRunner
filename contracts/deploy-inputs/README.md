# Mainnet deploy input (`DeployMainnet.s.sol` / `VerifyHandover.s.sol`)

One JSON file holds every external address and every parameter of a Robinhood Chain mainnet deployment:
`contracts/deploy-inputs/4663.json` (a filled copy of [`4663.example.json`](4663.example.json)), or
`46630.json` with `"network": "rehearsal"` for a testnet rehearsal of the same code path. Parsed by
[`script/MainnetInput.sol`](../script/MainnetInput.sol); a constructor change elsewhere means adding a field
here and in `MainnetInput` / `DeployMainnet._new*Impl`, never a constant in a script.

**Public addresses only.** No private key, mnemonic or KMS key id ever goes in this file. Role holders are the
addresses of the service keys (KMS: the address `roleSigner` derives from the key's public key).

**Placeholders.** Any non-zero address `<= 0x000000000000000000000000000000000000ffff` is a placeholder:
`validateInput` refuses to deploy while one is left. The example uses `0x…a0xx` (governance / treasury /
BKRN allocations), `0x…b0xx` (service roles), `0x…c0xx` (committee) and `0x…d001` (deployer); the oracle
signer's `measurement` / `quoteHash` are zero until the TEE build exists (refused). Addresses already confirmed
in `docs/VERIFY.md` are filled with their VERIFY values, and the Stock Tokens / Chainlink feeds with the values
of `config/chains/4663.json` (the oracle's chain price config, which the input must match); all must still be
re-checked on-chain (`checkExternals` does code / decimals / vault token / `uiMultiplier()` / feeds;
`bun run --cwd services/oracle source-check --chain 4663`; the operator compares bytes against the cited
source).

Numbers above 2^53 are decimal strings (`"100000000000000000000000"`); small ones may be JSON numbers.

## Fields

| Path | Type | Rule (checked by) | Source |
|---|---|---|---|
| `network`, `chainId` | string, uint | `mainnet`/4663 or `rehearsal`/46630, equal to the RPC chain (validate) | — |
| `deployer` | address | fresh one-shot EOA; must not be any other field (validate); holds nothing afterwards (verify) | operator |
| `governance.multisig` | address | Safe: must have code (externals). TimelockController proposer + executor + canceller | owners |
| `governance.timelockMinDelay` | uint (s) | `>= 172800` (48h) on mainnet (validate, verify) | RUNBOOK |
| `governance.guardian` | address | `GUARDIAN_ROLE` (pause new business only) | owners |
| `treasury.expenseRecipient` / `slashRecipient` | address | treasury multisig, not the deployer (validate, verify) | owners |
| `roles.markSigner` / `risk` / `opsVenue` / `jury` / `keeper` | address[] | non-empty, not the deployer; granted (verify) | service keys (KMS) |
| `committee` | address[3] | three distinct seats (RiskCommittee) | owners |
| `oracle.measurements[]` | bytes32[] | allowed enclave builds: `AttestedOracle.setMeasurement(m, true)` (verify) | VERIFY E1 (published build measurement) |
| `oracle.signers[]` | `{signer, platform, measurement, quoteHash}` | **attested form** (required on mainnet): `setAttestedSigner(signer, bytes32(platform), measurement, quoteHash)`; `measurement` must be listed in `oracle.measurements`; `platform` e.g. `INTEL_TDX` / `AMD_SEV_SNP` / `AWS_NITRO`; `quoteHash` = keccak256 of the raw quote (`services/oracle attest register` prints it). Verify: active, `attestationOf == attestationDigest(...)`, `measurementOf`. | VERIFY E1 (TEE), RUNBOOK "Oracle signer attestation" |
| `oracle.signers[]` (plain) | `{signer, attestation}` | rehearsal only: `setSigner(signer, true, attestation)` | — |
| `oracle.requireAttestations` | bool | **true on mainnet** (validate, verify): `requireAttestations()` after the signers (one-way) | VERIFY E1 |
| `externals.settlementToken` | address | code + **6 decimals** (externals); `config.usdc()` | VERIFY O3/S1 (USDG) |
| `externals.settlementSymbol` | string | informational | — |
| `externals.orderlyVault` | address | code; `getAllowedToken(keccak(orderlyTokenSymbol)) == settlementToken` (externals) | VERIFY O2/O7 |
| `externals.orderlyBrokerId` / `orderlyTokenSymbol` | string | hashed into the OrderlyAdapter implementation (verify) | VERIFY O7 (broker id from builder onboarding) |
| `externals.uniswapV3SwapRouter02` | address | code; HedgeExecutor `UNIV3` + BKRN buyback router (verify) | VERIFY U1 |
| `externals.uniswapV3Factory` | address | **required on mainnet**; code; `HedgeExecutor.setV3Factory` (then `setRoute` reverts `PoolNotFound` for a missing pool) (verify) | VERIFY U1 |
| `externals.uniswapV4Router` | address | optional (0 = `UNIV4` not configured) | VERIFY U2/U3 |
| `externals.uniswapV4PoolManager` | address | optional; required with `buyback.venue` `univ4` (code; `BkrnFeeRouter.setV4PoolManager`) | VERIFY U2 |
| `externals.entryPoint` | address | code; `config.entryPoint()` | VERIFY A1 |
| `externals.chainlinkFeeds[]` | `{symbol, feed}` | code + `latestRoundData()` (externals); must equal `chainPriceConfig`'s `chainlink.feeds.<symbol>.proxy` (validate, verify); copied to the deployment record | VERIFY C1/C4 |
| `externals.chainPriceConfig` | path | **required on mainnet**: the oracle's chain price config (`../config/chains/4663.json`, relative to `contracts/`; the oracle loads it by default on 4663, `ORACLE_CHAIN_CONFIG` overrides). Every input Stock Token / feed must be the same address there (validate, verify); recorded as `chainPriceConfig` | VERIFY T3/C4 |
| `bkrn.token` | address | 0 = deploy `BkrnToken`; else pre-existing BKRN, e.g. the Pons launch (code, 18 decimals required; `totalSupply` != 1e9 x 1e18 only warns; fee-on-transfer: RUNBOOK manual check) | VERIFY U6 |
| `bkrn.community` / `studio` / `liquidity` / `contributors` | address | required only when deploying BKRN (ignored, may be omitted, with `bkrn.token`); never the deployer (80/10/5/5) | owners / vesting |
| `stockTokens[]` | `{symbol, token, priceId, multiplierSource, multiplierWad, floatCapRaw, nextMultiplierAnchorWad?}` | code, decimals <= 18; registered (verify); token == `chainPriceConfig` | VERIFY T1-T3 |
| `stockTokens[].multiplierSource` | `uiMultiplier` \| `stored` | **`uiMultiplier` on mainnet** (validate): `setMultiplierSource(token, true)`, the registry reads the token's ERC-8056 `uiMultiplier()`; `multiplierWad` is the anchor = the current `uiMultiplier()` (externals: within the band, else the deploy would revert) | VERIFY T2 |
| `stockTokens[].nextMultiplierAnchorWad` | uint (WAD) | optional pre-approved anchor of a staged corporate action (`setNextMultiplierAnchor`; live mode only) | RUNBOOK "Corporate actions" |
| `stockRegistry.multiplierBandBps` | uint | optional (0 / absent = registry default 500); <= 5000: drift of the live multiplier from its anchor before valuations fail closed | VERIFY T2 |
| `hedge.routes[]` | `{symbol, fee, hop, hopFee}` | **exactly one per Stock Token** (validate): `HedgeExecutor.setRoute("UNIV3", token, fee, hop, hopFee)`; `hop` = 0 for the direct settlement/token pool (`hopFee` 0), or e.g. WETH (`0x0Bd7…AD73`, VERIFY S3) for a two-pool route; with the factory set every pool must exist (the simulation reverts `PoolNotFound` otherwise) (verify) | VERIFY U1/U4 (`scripts/check-pools.ts`) |
| `indexes[]` | `{name, priceId, components[{symbol, weightBps}]}` | symbols in `stockTokens`, weights sum 10000 | ARCHITECTURE §2.7 |
| `params.markInterval` | uint (s) | **86400** on mainnet (daily marks, VERIFY O11) | — |
| `params.maxMarkAge` / `maxPriceAge` / `maxTradePriceAge` / `committeeWindow` | uint (s) | > 0; committeeWindow >= 1 day (config) | ARCHITECTURE §2.1 |
| `params.carryBps` / `expenseCapBps` | uint | <= 10000 | — |
| `params.charterFeeUsd` / `sponsorBondBkrn` / `committeeBondBkrn` | uint | USDG 6dp / BKRN 18dp | — |
| `params.venueMinIfOrderly` | uint (6dp) | **> 25,000e6** on mainnet (Orderly's rule is strictly greater, VERIFY O10) | VERIFY O10 |
| `params.venueMinIfPoolEngine` | uint (6dp) | — | — |
| `params.tiers.thresholds` / `bonds` | uint[] | same length, ascending (config) | — |
| `params.backstopMaxCoverBps` | uint | 1..10000 | — |
| `params.stakingCooldown` / `stakingRewardsDuration` | uint (s) | cooldown >= 1 day | — |
| `params.oracleMinSources` | uint | `AttestedOracle.setMinSources` at deploy; > 0; **mainnet: exactly 1** (primary-confirm: the Chainlink primary signs alone with sourceCount 1; the DEX TWAP / Pyth only confirm; the oracle refuses to start unless `AttestedOracle.minSources() == 1`) | VERIFY C6 |
| `buyback.poolFee` / `refBkrnPerUsdcWad` / `maxSlippageBps` / `maxPerCall` | uint | fee tier of the BKRN/USDG pool, reference price near market, slippage <= 2000 | VERIFY U1 + market |
| `buyback.bkrnPriceId` | string | optional oracle price id of BKRN ("" = governance price) | — |
| `buyback.referenceSource` | `fixed` \| `twap` \| `attested` \| `fixedEth` | `BkrnFeeRouter.setReferenceSource` (default: `attested` with a `bkrnPriceId`, else `fixed`); `attested` needs `bkrnPriceId` (verify: source == input; `referenceBkrnPerUsdc()` reads for fixed / twap) | VERIFY U5 |
| `buyback.twap` | `{pool, window, maxTickDeviation}` | `twap` only, and only with a pre-existing `bkrn.token` (a BKRN deployed here has no pool yet: start `fixed`, switch through the timelock): pool = the BKRN/USDG v3 pool (code; observation cardinality must cover the window), window 600..172800 s, deviation 1..2000 ticks (`setTwapParams`) | VERIFY U5 |
| `buyback.poolFee` (univ4) | uint | may be 0 with `buyback.venue` `univ4` (no v3 BKRN pool; the v4 route carries its fee) | — |
| `buyback.venue` | `univ3` \| `univ4` | default `univ3` (SwapRouter02); `univ4` = direct Uniswap v4 PoolManager swaps for a Pons BKRN (`setBuybackVenue`); refuses `twap` | VERIFY U2/U6 |
| `buyback.v4Hooks` | address[] | hooks allow-listed at deploy (`setV4HookAllowed`; the PonsV2MemeHook), each with code; every hook of `v4Route` must be listed | VERIFY U6 |
| `buyback.v4HookFeeBps` / `buyback.v4EthHopBps` | uint | `setV4Fees`: hook fee allowance priced into hooked hops' limits (<= 1000; Pons ~120-350 observed) and the via-ETH first-hop share of the slippage (0 = a quarter); hook fee + share < `maxSlippageBps` | VERIFY U6 |
| `buyback.ethReference` | `{usdcPerEthWad, bkrnPerEthWad}` | fixed ETH references (`setEthReference`): USDG per ETH required by a via-ETH route and by `fixedEth`, BKRN per ETH read by `fixedEth` | VERIFY U7 |
| `buyback.v4Route` | `{kind, bkrnPool, ethPool?, v3Fee?, weth?}` | optional, only once BKRN has graduated (else set later through the timelock): `kind` `direct` (bkrnPool {USDG, BKRN}) \| `v4Eth` (bkrnPool {ETH, BKRN} + ethPool {ETH, USDG}) \| `v3Weth` (bkrnPool {ETH, BKRN} + `v3Fee` + `weth`); PoolKey = `{currency0, currency1, fee, tickSpacing, hooks}` (native ETH = 0x0, v4 order); pools must be initialized (checked on-chain); values from `bun scripts/buyback-route.ts --bkrn <token>` | VERIFY U6/U7 |
| `insurancePool.premiumFloorBps` / `marketCapBps` / `bufferBps` / `firstLossTargetBps` | uint (bps) | optional (2026-10 InsurancePool; omitted = the defaults 1200 / 3000 / 2000 / 1000, the owner-approved design); bounds <= 5000 / 100..10000 / <= 9000 / <= 5000 (`InsurancePool.setParam`; verify: params == input) | — |
| `insurancePool.cooldown` / `epochLength` / `processGrace` | uint (s) | optional (default 604800 / 604800 / 86400); cooldown <= 30 days, epoch 1..30 days (set only when it differs from 7 days; pending until the queue rolls), grace 1 h..7 days (an epoch waits for every pool-funded book's mark at most this long) | — |

## Pending inputs (owners)

- `deployer`, `governance.*`, `treasury.*`, `committee`, `bkrn.*` allocations: decided by the owners (Safe
  addresses, vesting contracts).
- `roles.*`, `oracle.signers[].signer`: the addresses of the KMS keys (deploy/server/MAINNET.md step 2).
- `oracle.measurements`, `oracle.signers[].measurement` / `quoteHash` / `platform`: from the reproducible enclave
  build and its verified quote (RUNBOOK "Oracle signer attestation", `services/oracle attest register`).
- `stockTokens[].token`, `externals.chainlinkFeeds[]`: filled from `config/chains/4663.json` (VERIFY T3 / C4: copied
  from Robinhood's asset registry and Chainlink's directory, not yet read on-chain — run `source-check`).
- `stockTokens[].multiplierWad`: the token's `uiMultiplier()` at deploy time (`source-check` prints it).
- `hedge.routes[]`: fee tier / hop per token from `scripts/check-pools.ts` (VERIFY U4; the example's direct 0.3%
  routes are placeholders that the simulation rejects if the pool does not exist).
- `externals.orderlyBrokerId`: assigned at Orderly builder onboarding; `orderlyTokenSymbol` must make
  `getAllowedToken` return USDG (VERIFY O7, checked on-chain by `checkExternals`).
- `buyback.refBkrnPerUsdcWad` / `poolFee`: from the BKRN/USDG pool once liquidity exists.
- `buyback.referenceSource` / `twap`: `fixed` at launch (BKRN has no pool yet); TWAP via the timelock once the
  BKRN/USDG pool has history (VERIFY U5).

## What the deployment wires from these fields

- OrderlyAdapter implementation `new OrderlyAdapter(keccak(orderlyBrokerId), keccak(orderlyTokenSymbol))` (v3:
  MM = the adapter proxy's own Orderly account, IF = a per-book `OrderlyIFAccount` deployed by the proxy at
  initialize; `decimals() == 6` and `getAllowedToken(tokenHash) == config.usdc()` checked there).
  `venueMinIfOrderly` > 25,000e6 (Orderly's rule is strictly greater).
- `Book` implementation: forge deploys the external library `BookLogic` from the deployer and links it; the
  record carries `contracts.bookImplementation` / `contracts.bookLogic`, VerifyHandover checks the link.
- HedgeExecutor: SwapRouter02, `setV3Factory`, one `setRoute` per Stock Token. BkrnFeeRouter: SwapRouter02,
  buyback params, reference source (+ TWAP params). StockTokenRegistry: band, register (anchor),
  `setMultiplierSource(token, true)`, next anchors. AttestedOracle: measurements, attested signers, minSources,
  `requireAttestations()`.
