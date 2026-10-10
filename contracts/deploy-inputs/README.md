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
BKRN allocations), `0x…b0xx` (service roles), `0x…c0xx` (committee), `0x…d001` (deployer), `0x…e0xx`
(Stock Tokens) and `0x…f0xx` (Chainlink feeds). Addresses already confirmed in `docs/VERIFY.md` are filled
with their VERIFY values and must still be re-checked on-chain (`checkExternals` does code / decimals / vault
token; the operator compares bytes against the cited source).

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
| `oracle.signers[]` | `{signer, attestation}` | attestation non-zero on mainnet (validate); active (verify) | VERIFY E1 (TEE) |
| `externals.settlementToken` | address | code + **6 decimals** (externals); `config.usdc()` | VERIFY O3/S1 (USDG) |
| `externals.settlementSymbol` | string | informational | — |
| `externals.orderlyVault` | address | code; `getAllowedToken(keccak(orderlyTokenSymbol)) == settlementToken` (externals) | VERIFY O2/O7 |
| `externals.orderlyBrokerId` / `orderlyTokenSymbol` | string | hashed into the OrderlyAdapter implementation (verify) | VERIFY O7 (broker id from builder onboarding) |
| `externals.uniswapV3SwapRouter02` | address | code; HedgeExecutor `UNIV3` + BKRN buyback router (verify) | VERIFY U1 |
| `externals.uniswapV4Router` | address | optional (0 = `UNIV4` not configured) | VERIFY U2/U3 |
| `externals.entryPoint` | address | code; `config.entryPoint()` | VERIFY A1 |
| `externals.chainlinkFeeds[]` | `{symbol, feed}` | code + `latestRoundData()` (externals); copied to the deployment record for the oracle service | VERIFY C1/C4 |
| `bkrn.token` | address | 0 = deploy `BkrnToken`; else pre-existing BKRN (code, 18 decimals) | — |
| `bkrn.community` / `studio` / `liquidity` / `contributors` | address | required when deploying BKRN; never the deployer (80/10/5/5) | owners / vesting |
| `stockTokens[]` | `{symbol, token, priceId, multiplierWad, floatCapRaw}` | code, decimals <= 18; registered (verify) | VERIFY T1-T3 |
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
| `params.oracleMinSources` | uint | > 0 | — |
| `buyback.poolFee` / `refBkrnPerUsdcWad` / `maxSlippageBps` / `maxPerCall` | uint | fee tier of the BKRN/USDG pool, reference price near market, slippage <= 2000 | VERIFY U1 + market |
| `buyback.bkrnPriceId` | string | optional oracle price id of BKRN ("" = governance price) | — |

## Pending inputs (owners)

- `deployer`, `governance.*`, `treasury.*`, `committee`, `bkrn.*` allocations: decided by the owners (Safe
  addresses, vesting contracts).
- `roles.*`, `oracle.signers[].signer`: the addresses of the KMS keys (deploy/server/MAINNET.md step 2).
- `oracle.signers[].attestation`: blocked on VERIFY E1 (TEE platform + verification flow).
- `stockTokens[].token`, `externals.chainlinkFeeds[]`: VERIFY T3 / C4 (canonical addresses not captured yet).
- `externals.orderlyBrokerId`: assigned at Orderly builder onboarding; `orderlyTokenSymbol` must make
  `getAllowedToken` return USDG (VERIFY O7, checked on-chain by `checkExternals`).
- `buyback.refBkrnPerUsdcWad` / `poolFee`: from the BKRN/USDG pool once liquidity exists.
- Changes landing from parallel work (OrderlyAdapter account ids / IF receiver, HedgeExecutor / BkrnFeeRouter
  USDG + TWAP, oracle sources): add their new constructor arguments under `externals` / `buyback` and wire
  them in `DeployMainnet` (`_newOrderlyAdapterImpl`, `_deployCore`), plus a row in `VerifyHandover`.
