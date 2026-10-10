# VERIFY register

Every external fact the protocol depends on but does not control. Mainnet (Robinhood Chain, 4663)
deployment is blocked until every row is **Confirmed** and the action column is done (RUNBOOK
"Mainnet" preconditions).

Status values:

- **Confirmed**: checked against the cited primary source (protocol docs or the protocol's own
  source code). Still re-check addresses byte-for-byte on-chain (`cast code <addr>` is non-empty, and
  the ABI matches) right before deployment.
- **Divergent**: confirmed, and it differs from what the devnet code or the spec assumes. Action needed.
- **Unconfirmed**: no primary source found, or only third-party sources.

Every address / parameter below that the deployment consumes is an input field of
`contracts/deploy-inputs/4663.json` (schema and row mapping: `contracts/deploy-inputs/README.md`);
`DeployMainnet.checkExternals` re-checks code, USDG decimals and the vault's token on-chain before any
transaction.

Research date: 2026-10-02 (A-orderly cluster). Sources were read through a summarising web fetch, so
every address below must be re-verified on-chain before use. The owner is the cluster that must act.

---

## 1. Orderly Network (venue: Perp Anything builder path) — owner: A-orderly / ops-venue

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| O1 | Orderly deployed on Robinhood Chain | **Confirmed** | Robinhood Chain is in Orderly's EVM chain list and has its own section on the address page. | https://orderly.network/docs/introduction/trade-on-orderly/supported-chains , https://orderly.network/docs/build-on-omnichain/addresses | — |
| O2 | Vault address on RHC | **Confirmed** (re-check on-chain) | Mainnet `Vault` `0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9` (same address as on Arbitrum / X Layer). Testnet `0x2A5b650A894409372DDeE241EDAC92d4152bE24d`. Also: VaultProxyAdmin `0xA2eA0a58b083c492AdC91A687FAc8B53AdB7c0Fd`, VaultCrossChainManager `0xA02e7DA50c7df5Fd22927B24Fa63B59ec8b22062`, CrossChainRelay `0x461C12FBa639303Da045255dd32eEa7E38AC69b0`. | https://orderly.network/docs/build-on-omnichain/addresses | `BookrunnerConfig.setOrderlyVault` on mainnet. |
| O3 | Deposit token on RHC | **Divergent** | Orderly's RHC section lists **USDG** (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` mainnet, `0x7E955252E15c84f5768B83c41a71F9eba181802F` testnet). No USDC is listed for RHC. Market-operations docs still state the IF requirement in USDC. | https://orderly.network/docs/build-on-omnichain/addresses , https://orderly.network/docs/build-on-omnichain/perp-anything/market-operations | Orderly books on RHC need `config.usdc()` = USDG (protocol-wide settlement in USDG), or a swap leg. `OrderlyAdapter` reverts `TokenNotAllowedByVenue` at initialize/deposit if `vault.getAllowedToken(tokenHash) != config.usdc()`. Check USDG decimals (protocol assumes 6). |
| O4 | `IOrderlyVault` ABI (frozen interface) | **Confirmed — identical** | `VaultDepositFE{bytes32 accountId; bytes32 brokerHash; bytes32 tokenHash; uint128 tokenAmount}`, `VaultDelegate{bytes32 brokerHash; address delegateSigner}`, `deposit(VaultDepositFE) payable`, `depositTo(address receiver, VaultDepositFE) payable`, `getDepositFee(address receiver, VaultDepositFE) view returns (uint256)`, `delegateSigner(VaultDelegate)`, `getAllowedToken(bytes32) view returns (address)` all match `contracts/src/interfaces/external/IOrderlyVault.sol`. The real vault has more functions (e.g. `getAllowedBroker(bytes32)`, `withdraw`, `withdraw2Contract`, `delegateSwap`) that the protocol does not call. | https://github.com/OrderlyNetwork/contract-evm (`src/interface/IVault.sol`, `src/library/types/VaultTypes.sol`, `src/vaultSide/Vault.sol`) | None. |
| O5 | Deposit semantics | **Confirmed** | `_validateDeposit`: broker allowed (`BrokerNotAllowed`), token allowed/enabled, `accountId` valid (`AccountIdInvalid`) unless the caller is the vault's `vaultAdapter`, `tokenAmount != 0` (`ZeroDeposit`). Pulls `tokenAmount` with `safeTransferFrom(msg.sender)`; optional per-token deposit limit (`DepositExceedLimit`). If `depositFeeEnabled`, `msg.value` must be non-zero (`ZeroDepositFee`) and goes to the cross-chain manager **with refund to `msg.sender`**. Emits `AccountDepositTo(accountId, brokerHash, userAddress, depositNonce, tokenHash, tokenAmount)`. | `src/vaultSide/Vault.sol` (contract-evm) | Adapter pays `getDepositFee` from its own ETH and has `receive()` for refunds. **Pre-fund each Orderly adapter with ETH on mainnet**: if the fee is enabled and the adapter has no ETH, `closeWindow` deployment reverts (`InsufficientNativeForFee`). |
| O6 | accountId derivation | **Divergent** | Orderly: `accountId = keccak256(abi.encode(address user, bytes32 brokerHash))` (`Utils.calculateAccountId` / `validateAccountId`), so there is **one account per (address, broker)**. Strategy-vault accounts use `keccak256(abi.encode(address vault, address user, bytes32 brokerHash))`, but only for the vault's registered `vaultAdapter`. The devnet derivation in `OrderlyAdapter` (`keccak256(abi.encode(adapter, brokerHash, account))`, two accounts per adapter) is accepted only by `MockOrderlyVault` (or `MockOrderlyVault.setStrictAccountIds(true)` to reproduce the real check). On the real vault both `getDepositFee` and `deposit` revert `AccountIdInvalid`. | `src/library/Utils.sol` (contract-evm); https://orderly.network/docs/build-on-omnichain/user-flows/accounts | Before mainnet, timelock-upgrade `OrderlyAdapter` with a real mapping: MM = the adapter's own account `keccak256(abi.encode(adapter, brokerHash))`; IF = the builder IF account assigned to the symbol (see O9), or a second receiver contract per book. Account ids are not stored, so an upgrade changes them in one place (`_accountId`). |
| O7 | brokerHash / tokenHash conventions | **Confirmed** | `calculateStringHash(s) = keccak256(abi.encodePacked(s))`. `brokerHash = keccak256(bytes(brokerId))`, `tokenHash = keccak256(bytes(symbol))`; `keccak256("USDC") = 0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa`. Devnet: brokerId `bookrunner` → `0x83c328a842cde1f424b861fd7dbb8c437c757ac45881c6bc6e72697b898b9aba`. RHC/USDG would be `keccak256("USDG") = 0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea` (**Unconfirmed** that Orderly uses the symbol `USDG` as the hash pre-image; read `getAllowedToken` on-chain). | `src/library/Utils.sol`; https://orderly.network/docs/build-on-omnichain/user-flows/accounts | Pass both to the `OrderlyAdapter` implementation constructor. The broker id is assigned at builder onboarding (`ORDERLY_BROKER_ID`). |
| O8 | Smart-contract accounts / delegate signer | **Confirmed** | `Vault.delegateSigner` requires `msg.sender` to be a contract (`ZeroCodeLength`), the delegate to be an EOA (`NotZeroCodeLength`) and the broker to be allowed. It emits `AccountDelegate(delegateContract, brokerHash, delegateSigner, chainId, blockNumber)`. The EOA then confirms via `POST /v1/delegate_signer` (EIP-712 `DelegateSigner{delegateContract, brokerId, chainId, timestamp, registrationNonce, txHash}`). One EOA per contract account (a new one replaces the old). Contract accounts are **single-chain** (deposit/withdraw only on the chain where `delegateSigner` was called) and always need the EOA to withdraw, through the delegate-signer endpoints. | https://orderly.network/docs/build-on-omnichain/user-flows/delegate-signer ; `src/vaultSide/Vault.sol` | `OrderlyAdapter.setDelegateSigner` (timelock). ops-venue runs the API confirmation. |
| O9 | Withdrawal receiver for contract accounts | **Unconfirmed** | The withdraw EIP-712 message includes `receiver` (and `allowCrossChainWithdraw`). Whether Orderly forces `receiver == contract account` for delegate accounts is not documented. The adapter's invariant (USDC leaves only to vault/router) covers the contract only. An Orderly withdrawal signed by the delegate EOA with a foreign receiver would be an off-chain trust failure. | https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/private/create-withdraw-request | Confirm with Orderly. ops-venue must always sign `receiver = adapter`. Keep the delegate key in an HSM, separate from trade keys. |
| O10 | Perp Anything insurance fund (IF) | **Confirmed** (mechanics partly **Unconfirmed**) | 25,000 USDC per effective symbol on mainnet (100 on testnet). Each symbol is assigned to exactly one IF account; a builder may have several IF accounts. The rule is **strictly greater**: `IF balance > requirement × symbols on that IF account`. The IF is withdrawable when the market is delisted and obligations are settled. ADL applies only to positions in that market. How an IF account is created and funded (dashboard vs API, sub-account vs separate wallet) is not documented. | https://orderly.network/docs/build-on-omnichain/perp-anything/market-operations , https://orderly.network/docs/build-on-omnichain/perp-anything/introduction | **A-gov**: a charter with `ifTargetUsd == 25,000` fails Orderly's strict rule. Either set `venueMinIf[Orderly]` above 25,000 (e.g. 25,001e6) or make `IF_BELOW_VENUE_MIN` fire on `<=`. ops-venue: IF withdrawals before delisting will be refused (use `cancelWithdraw`). |
| O11 | Builder fee share / settlement | **Confirmed** | 50% of Orderly **base taker** fees on the builder's markets (excludes maker, liquidation and funding fees), settled **once per day to the builder's DEX Admin account**. Reconciliation: `GET /v1/broker/daily_fee_revenue` (field `permissionless_listing_fee_share`). | https://orderly.network/docs/build-on-omnichain/perp-anything/market-operations | Fees land in the builder admin account, not the book's accounts. ops-venue: `adapter.sweepFees(period, amount)` (earmark, ≤ cap) → withdraw the share from the admin account to the adapter → `forwardPendingFees()`. Mainnet `markInterval` 86400 matches the daily settlement. |
| O12 | Builder market cap / statuses | **Confirmed** | `REDUCE_ONLY` (close-only) and `DELISTED` (terminal) statuses. A default cap of 5 markets is mentioned. Perp Anything markets are isolated-margin only. | https://orderly.network/docs/build-on-omnichain/perp-anything/market-operations | Launch plan (2 Orderly books) is within the cap. |
| O13 | REST endpoints (`packages/shared/src/orderly.ts`) | **Partly confirmed** | Confirmed: `POST /v1/withdraw_request` (EIP-712, verifyingContract `0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203`), `POST /v1/delegate_signer`, `GET /v1/transfer_nonce`, `POST /v2/internal_transfer`, `GET /v1/broker/daily_fee_revenue`. Unconfirmed: `/v1/builder/*` paths (symbol creation, price source, IF, fee settlements) and the delegate withdraw endpoint name. | Orderly docs pages above; https://orderly.network/docs/build-on-omnichain/user-flows/builder-oracle | ops-venue live client. |
| O14 | Symbol naming | **Confirmed** | `PERP_<TOKEN>_USDC` format. | https://orderly.network/blog/create-a-perp-market | — |
| O15 | Withdrawal fee | **Confirmed** (amount Unconfirmed) | `VaultWithdraw` carries a `fee`; the receiver gets `tokenAmount - fee`. | `src/library/types/VaultTypes.sol`, `src/vaultSide/Vault.sol` | ops-venue uses `confirmWithdrawWithFee(nonce, fee)` so in-transit clears exactly. |
| O16 | Withdraw failure | **Confirmed** (event exists) | The vault emits `WithdrawFailed`, so a vault-side payout can fail after the ledger executed it. | `src/interface/IVault.sol` | ops-venue: `failWithdraw(nonce)` returns the amount to venue-side until the next report. |

## 2. Robinhood Chain — owner: integrator / all services

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| R1 | Chain id | **Confirmed** | Mainnet `4663`, testnet `46630`. Arbitrum Orbit (Nitro) L2, ETH gas token, about 100 ms blocks. | https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments , https://docs.chainstack.com/reference/robinhood-getting-started | `chains.ts` already uses 4663. |
| R2 | Public RPC / explorer | **Unconfirmed** | Third-party sources give RPC `https://rpc.mainnet.chain.robinhood.com` (testnet `https://rpc.testnet.chain.robinhood.com`) and explorers `robinhoodchain.blockscout.com` / `robinscan.io` (sources disagree). | https://trustswap.com/robinhood/network-details , Chainstack page above | Use the Dwellir archive endpoint from the secret store (`RHC_RPC_URL`). Update `chains.ts` placeholders once confirmed in Robinhood's docs. |
| R3 | Dwellir archive RPC | **Unconfirmed** | Dwellir publishes RHC material; archive endpoint not verified. | https://www.dwellir.com/blog/what-is-robinhood-chain | Ops. |
| R4 | `block.timestamp` / Arbitrum semantics | **Unconfirmed** | Nitro timestamps follow L1 with sequencer bounds. Marks, fee periods and the adapter's sweep gate are timestamp-aligned. | — | Check sequencer timestamp drift bounds. |

## 3. Stablecoins — owner: A-core / integrator

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| S1 | USDG on RHC | **Confirmed** | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Robinhood token contracts page; same address on Orderly's page). | https://docs.robinhood.com/chain/contracts | Decimals: check on-chain (protocol assumes 6). |
| S2 | USDC on RHC | **Unconfirmed / likely absent** | Robinhood's canonical token page lists WETH and USDG only. No Circle native USDC address found for RHC. | https://docs.robinhood.com/chain/contracts , https://developers.circle.com/stablecoins/usdc-contract-addresses | Decide the protocol settlement token for RHC (USDG recommended; see O3). |
| S3 | WETH on RHC | **Confirmed** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. | https://docs.robinhood.com/chain/contracts | Buyback/hedge routing if WETH hops are needed. |

## 4. Stock Tokens — owner: A-mandate (StockTokenRegistry) / oracle

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| T1 | Token standard | **Confirmed** | Plain ERC-20, **18 decimals**, one token per equity/ETF. | https://docs.robinhood.com/chain/stock-tokens/ | — |
| T2 | Multiplier | **Confirmed** | Corporate actions use an on-chain multiplier read via `uiMultiplier()` (ERC-8056 "Scaled UI Amount"). Raw balances stay static. | https://docs.robinhood.com/chain/stock-tokens/ | Registry multiplier source on mainnet = `uiMultiplier()` (check its scale; protocol uses WAD). |
| T3 | Canonical addresses | **Unconfirmed** | Generated from Robinhood's on-chain asset registry and listed on the token contracts page / `api.robinhood.com/rhj/assets`. NVDA/TSLA/AAPL/MSFT/AMZN addresses not captured. | https://docs.robinhood.com/chain/contracts , https://docs.robinhood.com/chain/stock-token-apis/ | Fill `deployments/4663.json`. |
| T4 | Transfer / jurisdiction restrictions | **Confirmed** | Not offered to US persons; further restrictions in CA, UK, CH and other jurisdictions. Lending use is not prohibited by the docs. | https://docs.robinhood.com/chain/stock-tokens/ | Copy rules (already: "Not available to US persons"). |

## 5. Chainlink equity feeds — owner: oracle service / A-mandate

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| C1 | Feeds on RHC | **Confirmed** | Chainlink is the on-chain price source on RHC. Robinhood tokenized-equity feeds exist (standard `AggregatorV3` `latestRoundData()`). Data Streams are also available. | https://docs.robinhood.com/chain/oracles-and-price-feeds/ , https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood | — |
| C2 | **Feed price already includes the multiplier** | **Divergent** | `Token Price = Underlying Equity Market Price × Multiplier`, where the multiplier is read from the token's `uiMultiplier()`. The feed is **per token**, not per share. | https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood , https://docs.robinhood.com/chain/stock-tokens/ | **Red-team "multiplier applied exactly once"**: `StockTokenRegistry.valueUsd` multiplies a per-share price by the multiplier. If the oracle service publishes Chainlink per-token prices, it must divide by the multiplier first (or the registry must take per-token prices with the multiplier forced to 1e18). Otherwise holdings are valued multiplier² times. |
| C3 | Market hours | **Confirmed** | Feeds are 24/5 (regular, pre, post and overnight sessions). Off-hours the feed may hold the last price while `latestRoundData()` stays callable. | https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood | Oracle `held` flag must come from the session calendar, not from feed reverts. |
| C4 | Feed addresses / decimals / heartbeats | **Unconfirmed** | Maintained on Chainlink's address page (`?network=robinhood`; page too large to fetch here). Most USD feeds use 8 decimals; read `decimals()`. | https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood | Oracle config. |

## 6. Uniswap on RHC — owner: A-mandate (HedgeExecutor) / A-core (buybacks)

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| U1 | v3 deployment | **Confirmed** | `SwapRouter02 0xcaf681a66d020601342297493863e78c959e5cb2`, `UniswapV3Factory 0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, `QuoterV2 0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`, `NonfungiblePositionManager 0x73991a25c818bf1f1128deaab1492d45638de0d3`, `Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3`. | https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments | `HedgeExecutor.setRouter(UNIV3, SwapRouter02)` via timelock. |
| U2 | v4 deployment | **Confirmed** | `PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951`, `PositionManager 0x58daec3116aae6d93017baaea7749052e8a04fa7`, `Quoter 0x8dc178efb8111bb0973dd9d722ebeff267c98f94`, `StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, `UniversalRouter 0x8876789976decbfcbbbe364623c63652db8c0904`. | https://developers.uniswap.org/docs/protocols/v4/deployments | — |
| U3 | UniversalRouter calldata | **Unconfirmed** (third-party) | A third-party integration guide says the RHC UniversalRouter is a Robinhood-modified fork with an extra `minHopPriceX36` field in its v4 swap struct, so stock SDK calldata reverts. | https://docs.bags.fm/robinhood/overview | Keep `UNIV4` = `NotConfigured` until verified against the deployed bytecode. |
| U4 | Stock Token pools / liquidity | **Unconfirmed** | Pools per hedge asset (fee tier, depth) not verified. | — | Per-asset check before allow-listing (`hedgeAllowRoot`). |

## 7. Account abstraction — owner: A-mandate (BookrunnerDesk)

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| A1 | EntryPoint v0.7 on RHC | **Confirmed** | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (v0.6 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` and v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` also deployed). Bundlers: Alchemy, ZeroDev. EIP-7702 supported. | https://docs.robinhood.com/chain/account-abstraction/ | `config.setEntryPoint`. |

## 8. TEE attestation (AttestedOracle signer) — owner: A-engine / oracle service

| # | Item | Status | Finding | Source | Action |
|---|---|---|---|---|---|
| E1 | TEE platform + quote verification | **Unconfirmed** | No platform chosen and no on-chain or off-chain verification flow specified. Devnet registers a plain key with a placeholder attestation hash. | Spec only | Choose a platform (e.g. SGX/TDX/SEV-SNP), define the verification and the registered digest (`AttestedOracle.setSigner(signer, active, attestation)`), and publish verification steps. |

---

## Devnet stand-ins (what the VERIFY items above map to locally)

| Real dependency | Devnet | Notes |
|---|---|---|
| Orderly Vault | `MockOrderlyVault` | Same `IOrderlyVault` ABI and event signatures as the real vault. Any non-zero accountId is accepted (strict mode reproduces O6). Single token. Deposit fee 0 (settable). The operator simulates payouts (`operatorWithdraw*`), fee settlement / PnL (`creditFees`) and losses (`debitAccount`). Withdrawals pay only the account's on-chain owner. |
| Orderly REST | `services/mock-orderly` | Indexes `AccountDepositTo` / `AccountWithdraw` / `AccountDelegate` from the mock. |
| USDC / USDG | `MockERC20` (6 dp) | — |
| Stock Tokens | `MockERC20` (18 dp) + registry multiplier | — |
| Uniswap | `MockSwapRouter` | — |
| EntryPoint | direct `execute` on devnet | — |

## OrderlyAdapter deployment parameters

- Implementation constructor: `OrderlyAdapter(bytes32 defaultBrokerHash, bytes32 defaultTokenHash)`.
  Devnet: `(keccak256("bookrunner"), keccak256("USDC"))`. Mainnet: `(keccak256(<ORDERLY_BROKER_ID>),
  <hash for which getAllowedToken returns config.usdc()>)`. The hashes are copied into each proxy at
  `initialize`. New defaults for future books mean a new implementation, registered through the
  timelock-gated factory implementation setter. Existing books keep their hashes across upgrades.
- Mainnet blockers specific to the adapter: O3 (token), O6 (accountId upgrade), O9 (receiver), O10
  (IF account mechanics), O5 (ETH pre-funding).
