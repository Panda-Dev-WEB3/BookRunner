# Bookrunner — Architecture (normative build contract)

Source specs: *Bookrunner Overview* and *Bookrunner Backend* (Spec v1.0, 2026-10-01). This document
turns them into exact, buildable semantics. Where the spec is silent, the decision here is binding
and marked **[ext]**. Every unverified external address / ABI / endpoint is marked **VERIFY**.

Robinhood Chain (4663) is the target chain. Local development runs on anvil (31337) with mocks for
every external dependency (Orderly vault + REST, Uniswap router, Stock Tokens, USDC).

---

## 0. Repository layout

```
contracts/                Foundry project (solc 0.8.30, cancun, OZ 5.7 vendored in lib/)
  src/interfaces/         FROZEN cross-cluster interfaces + BRTypes (change only via the integrator)
  src/libraries/          Waterfall.sol, ...
  src/                    implementations (see §2 ownership)
  src/mocks/              devnet/test mocks (never deployed to mainnet)
  test/                   unit / fuzz / invariant tests; test/vectors/waterfall.json (parity)
  script/                 Deploy.s.sol, LaunchBooks.s.sol
  deployments/<chainId>.json
packages/shared           @bookrunner/shared — types, units, NORMATIVE waterfall + mandate math,
                          sessions codec, EIP-712, Merkle, queues, events, copy rules, ABIs (generated)
packages/db               @bookrunner/db — Drizzle schema, migrations, Timescale hypertables
services/<name>           one package per service (§4)
apps/web                  dashboards (Vite + React)
scripts/                  forge.sh (Docker Foundry), gen-abi.ts, gen-vectors.ts, check-copy.ts, dev.ts
docs/                     this file, BOUNTY_SCOPE.md, RUNBOOK.md, VERIFY.md
```

### Toolchain (this host)

- **Foundry runs in Docker**: `bash scripts/forge.sh build|test|script ...` (native forge.exe is
  blocked by Windows application control). `FOUNDRY_TOOL=cast bash scripts/forge.sh ...` for cast.
  Inside the container the host anvil is `http://host.docker.internal:8547`.
- **Bun** is a devDependency: bootstrap with `npx -y bun@1.4.2 install` at the repo root, then use
  `./node_modules/.bin/bun` (Windows: `bun.exe`). Workspaces use bun's isolated linker.
- **Infra**: `docker compose up -d` → Postgres+Timescale `127.0.0.1:54400`, Redis `127.0.0.1:63790`,
  anvil `127.0.0.1:8547` (chain 31337, test mnemonic, 1s blocks).
- **ABIs**: `bun scripts/gen-abi.ts` after `forge build` → `packages/shared/src/abi/*.ts`.
- **Parity vectors**: `bun scripts/gen-vectors.ts` → `contracts/test/vectors/waterfall.json`.

### Units (protocol-wide; see `BRTypes.sol`, `packages/shared/src/units.ts`)

| Quantity | Unit |
|---|---|
| USD amounts (`...Usd`) | 6 decimals (USDC units) |
| Tranche shares | 6 decimals; 1 share = 1 USDC unit at window close |
| Prices | WAD (1e18) USD per 1 whole unit of underlying |
| Stock Token multiplier | WAD, shares of equity per 1 whole token |
| Engine position size | 1e18 = 1 unit of underlying |
| bps | 1e4 = 100% |

Rounding: always floor; payouts never exceed what is owed; dust stays in the book.

### Roles (granted on `BookrunnerConfig` by the timelock)

| Role | Holder (devnet anvil index) | Powers |
|---|---|---|
| admin / timelock | deployer (0) via TimelockController (48h mainnet; 0s devnet) | upgrades, params, members, signers |
| `MARK_SIGNER` | mark service (1) | signs EIP-712 marks |
| `RISK` | risk service (2) | kill, revoke keys, reduce-only desk actions |
| `OPS_VENUE` | ops-venue (3) | Orderly reports, fee sweeps, withdraw confirmations |
| `JURY` | charter service (4) | posts jury verdict digests |
| `KEEPER` | keeper (5) | distribute, recall before marks, buybacks |
| `GUARDIAN` | deployer (0) | pause NEW books/deposits — never redemptions |
| oracle signer | oracle (6) | registered on AttestedOracle (not a config role) |

Devnet keys come from `packages/shared/src/devkeys.ts`. Non-local chains require explicit env keys.

---

## 1. System overview

```
Sponsor ──file(charter, fee, bond)──► MarketCharter ──► RiskCommittee (jury CID + 2-of-3 bonded) ──decide──►
BookFactory.create ──► Book{ Senior, Junior, UnderwritingVault, MMMandate, RevenueRouter, BookrunnerDesk, VenueAdapter }
  ├─ Orderly path:   OrderlyAdapter → Orderly Vault (IF + MM accounts; trade-only keys)   ◄── bookrunner agent (REST)
  └─ In-house path:  PoolEngineAdapter → PoolEngine market (AttestedOracle, off-hours regime) ◄── agent (desk SetQuote)
Fee flow: venue/engine → RevenueRouter.distribute → expenses → 10% carry → BkrnFeeRouter(50% buyback / 50% Backstop)
          → Senior share → Junior residual → UnderwritingVault (credited to S/J)
Marks:    mark service → MarkRegistry.commit(EIP-712) → Book.applyMark → losses J→S→Backstop, redemptions settle
```

Per book, **bookId == charterId**.

---

## 2. Contracts

### 2.0 Ownership (build clusters — file-disjoint)

| Cluster | Files (src/ + tests) |
|---|---|
| **A-core** | `BookrunnerConfig.sol`, `BkrnToken.sol`, `BkrnStaking.sol`, `BkrnFeeRouter.sol`, `Backstop.sol`, `MarkRegistry.sol`, `RevenueRouter.sol`, `mocks/MockSwapRouter.sol` (USDC↔BKRN for buybacks + USDC↔Stock Token for hedges, priced from AttestedOracle or a settable price) |
| **A-book** | `libraries/Waterfall.sol`, `Book.sol` (UUPS), `Tranche.sol` (+ thin `SeniorTranche.sol`/`JuniorTranche.sol` naming wrappers optional), `UnderwritingVault.sol`, `test/WaterfallParity.t.sol` |
| **A-gov** | `MarketCharter.sol`, `RiskCommittee.sol`, `BookFactory.sol` |
| **A-mandate** | `MMMandate.sol`, `BookrunnerDesk.sol`, `HedgeExecutor.sol`, `StockTokenRegistry.sol` |
| **A-engine** | `AttestedOracle.sol`, `PoolEngine.sol`, `PoolEngineAdapter.sol` (UUPS) |
| **A-orderly** | `OrderlyAdapter.sol` (UUPS), `mocks/MockOrderlyVault.sol` |
| **integrator** | `script/*`, `test/integration/*`, `test/invariant/*`, interface changes |

Rules: implement exactly the frozen interfaces in `src/interfaces/` (add functions in your
implementation freely; do not change interface signatures — if you must, document it in your
report and the integrator reconciles). For tests, mock siblings you don't own with minimal
in-test contracts (`test/utils/` files prefixed with your cluster, e.g. `test/utils/BookMocks.sol`).

Upgradeability: **non-upgradeable** except `Book` (ERC1967 proxy, UUPS, `_authorizeUpgrade` only
`config.timelock()`) and venue adapters (same). Clones (EIP-1167) for Tranche ×2, Vault, Mandate,
Router, Desk. All initializers use OZ `Initializable` and are locked on the implementation
(`_disableInitializers()` in constructor).

### 2.1 BookrunnerConfig [A-core]

AccessControl registry implementing `IBookrunnerConfig`. `DEFAULT_ADMIN_ROLE` = timelock. Role ids
are `keccak256("MARK_SIGNER")` etc. Setters (admin only) for every address/param, emitting
`AddressSet`/`ParamSet`. `timelock()` returns the recorded address only while it holds
`DEFAULT_ADMIN_ROLE` (else `address(0)`, fail-closed), and `setAddress("timelock", t)` requires `t`
to hold it, so every timelock-gated power follows the admin role across the handover. `setNewBooksPaused(bool)` callable by admin or GUARDIAN.
Settlement token: the `usdc` key (name kept for ABI stability) is the protocol settlement token —
mock USDC on devnet/testnet, **USDG on Robinhood Chain** (VERIFY O3/S1). `setAddress("usdc", t)`
reverts `BadSettlementToken(t, decimals)` unless `t` is a contract whose `decimals()` returns
`SETTLEMENT_DECIMALS` (6): every USD amount in the protocol is 6-dp and valued 1:1. "USDC" in names
and in the amounts below means that token; the apps show its on-chain `symbol()`.
`agentTierBond(inventoryUsd)`: step function over sorted tiers `[(inventoryUsdThreshold, bond)]`;
returns 0 below the entry tier. Defaults (mainnet): carryBps 1000, expenseCapBps 2000, charterFee
5,000 USDC, sponsorBond 100,000 BKRN, committeeBond 250,000 BKRN, markInterval 86400, maxMarkAge
21600, maxPriceAge 300, committeeWindow 172800, venueMinIf[Orderly] 25,001 USDC (Orderly needs IF > 25,000),
venueMinIf[PoolEngine] 10,000 USDC, tiers: entry 50k USD → 0, ≥50k → 25k BKRN, ≥250k → 100k BKRN,
≥1M → 400k BKRN. Devnet overrides markInterval 300, maxMarkAge 3600, committeeWindow 172800.

### 2.2 BkrnToken, BkrnStaking, BkrnFeeRouter, Backstop [A-core]

- `BkrnToken`: ERC20 "Bookrunner" / "BKRN", 18 decimals, fixed supply 1,000,000,000 minted in the
  constructor **80 / 10 / 5 / 5** to four recipient addresses passed in (labels in deployment
  config: `community`, `studio`, `liquidity`, `contributors` — **[ext]** labels; spec gives only the
  split). ERC20Permit. No mint after construction.
- `BkrnStaking`: `IBkrnStaking`. Cooldown 7 days (param, >= 1 day). Lockers set by admin (MarketCharter,
  RiskCommittee, every book's MMMandate — the factory is authorised to add mandate clones as
  lockers: `setLocker` callable by admin or factory). `lock` requires `availableOf >= amount`
  (locks are keyed `(account, lockId)` and only the locker that created a lock may unlock/slash it).
  `slash` transfers slashed BKRN to `config.slashRecipient()`. Rewards: Synthetix-style
  reward-per-token accumulator over the *earning* balance (`staked - pendingUnstake`: stake in its
  unstake cooldown does not earn), funded by `notifyReward` (only feeRouter; BKRN transferred in
  first) and STREAMED over `rewardsDuration` (timelock param, default 7 days; rewardRate /
  periodFinish) so stake placed just before a buyback cannot take carry accrued before it (A5-03). "Access and bonding, never a revenue claim" is a copy rule for the UI;
  the buyback distribution is specified in §5 of the overview and implemented as written.
- `BkrnFeeRouter`: `notifyCarry` only callable by a factory-registered component (RevenueRouter);
  splits 50/50 (odd unit to backstop): backstop share transferred to `Backstop` + `notifyDeposit`;
  buyback share accumulates. `executeBuyback(amountIn, minBkrnOut)` (KEEPER) swaps via
  `ISwapRouter02.exactInputSingle` (dedicated `buybackRouter` param) through the timelock-pinned
  `buybackPoolFee`, at most `maxBuybackPerCall` per call, with `amountOutMinimum >=
  amountIn x reference x (1 - maxSlippageBps)`; the reference source is governance-chosen
  (`referenceSource`): REF_FIXED = the timelock-set `refBkrnPerUsdcWad` (A5-02), REF_TWAP = Uniswap v3
  TWAP of the BKRN/settlement pool (`libraries/UniswapV3Twap.sol`: mean tick over `twapWindow` ∈
  [10 min, 2 days], refused with `TwapDeviation` while the spot tick is more than
  `twapMaxTickDeviation` ≤ 2,000 ticks away; "OLD" when the pool's history is shorter than the
  window), REF_ATTESTED = AttestedOracle `bkrnPriceId`. Sends BKRN to staking and calls `notifyReward`.
- `Backstop`: holds USDC. `cover(bookId, shortfall)` only by `factory.bookOf(bookId) == msg.sender`;
  pays `min(shortfall, balance)` to the book's vault; emits `Covered`. Optional per-cover cap param
  (`maxCoverBps` of balance, default 10000).

### 2.3 MarkRegistry [A-core]

`IMarkRegistry`. EIP-712 domain `("Bookrunner MarkRegistry","1")`. `commit` checks: signer has
`MARK_SIGNER`; `periodEnd % markInterval == 0`; `periodEnd > lastPeriodEnd[bookId]`;
`periodEnd <= block.timestamp`; `block.timestamp - periodEnd <= maxMarkAge`; book exists
(`factory.bookOf(bookId) != 0`). Mark ids are global, start at 1. `markApplied` only callable by
`factory.bookOf(mark.bookId)`. **[ext]** Stale-mark replacement: `periodEnd == lastPeriodEnd[bookId]`
is also accepted (new mark becomes `latestMarkId`, emits `MarkSuperseded`) while the latest mark is
unapplied and its `flowNonce != book.flowNonce()` (it can never be applied), so a capital flow between
commit and apply never burns the period; `latestMarkReplaceable(bookId)` previews it.

### 2.4 RevenueRouter [A-core]

`IRevenueRouter`, clone per book. `notifySettlement(source, amount)`: requires the router's USDC
balance to have grown by `>= amount` since last accounted balance (pull-free push; reverts
otherwise) and records `pendingGross += amount`. `distribute(period, expensesRequested)` (KEEPER):
split per `splitDistribution` in `packages/shared/src/waterfall.ts` using `config.expenseCapBps`,
`config.carryBps`, `charter.seniorHurdleBps`, current tranche supplies; transfers expenses →
`config.expenseRecipient()`, carry → feeRouter (`notifyCarry`), senior+junior → vault and calls
`book.creditDistribution(senior, junior)`; emits `Distributed(bookId, period, [gross, expenses,
carry, senior, junior])`. Each `period` may be distributed once (idempotency for the waterfall
service). A distribution with `gross == 0` is a no-op but still marks the period.

### 2.5 Book, Tranche, UnderwritingVault, Waterfall [A-book]

**Waterfall.sol** — pure library mirroring `packages/shared/src/waterfall.ts` exactly:
`allocateWindow`, `walletAllocation`, `initialDeployment`, `splitDistribution`, `applyMarkPnl`,
`sharePriceWad`, `bucketIndex`. `test/WaterfallParity.t.sol` must pass all rows of
`test/vectors/waterfall.json` (format documented in `scripts/gen-vectors.ts`). Reason codes:
1 NO_JUNIOR, 2 SPONSOR_SKIN, 3 IF_UNFUNDED.

**Book** state machine:

```
Subscription --closeWindow ok--> Live --retire--> Retiring --finalizeRetirement--> Retired
     \--closeWindow fail--> Cancelled (all commitments refundable 1:1 via claimCancelledRefund)
```

- `closeWindow()` (anyone, `now >= subscriptionEnds`): reads both tranches' committed totals and the
  sponsor's Junior commitment `P` → `Waterfall.allocateWindow`. **Sponsor priority [ext]** (closes
  the last-block over-commit griefing): the Junior eligible for allocation is
  `min(juniorCommitted, 10·P)` (uncapped when `P == 0`); Senior cap and raise limit apply to it as
  before; the sponsor is allocated first (`sponsorJuniorAllocated = min(P, juniorAllocated)`) and
  every other Junior wallet shares `juniorAllocated − sponsorJuniorAllocated` pro-rata on the
  non-sponsor commitments, the excess refunded. The sponsor therefore always holds ≥ 10% of
  allocated Junior, and outside over-commitment is refunded instead of cancelling the book.
  `SPONSOR_SKIN` remains only for a window where the sponsor committed no Junior while Junior can be
  allocated. On failure → Cancelled, emit
  `BookCancelled(reason)` (tranches `markCancelled`). On success: `S = seniorAllocated`,
  `J = juniorAllocated`; tranches `settleWindow(allocated, vault)` move allocated USDC to the vault
  (refunds stay in tranche escrow for `claimAllocation`); `initialDeployment` → `vault.deployToVenue(IF)`
  then `vault.deployToVenue(MM)`; state Live; perfIndex = highWater = 1e18.
- `applyMark(markId)` (anyone): mark must be for this book, not applied, newer than the last applied,
  and `mark.flowNonce == flowNonce`. `nav = Waterfall.markedNavNet(vault.idle(), unfundedClaims,
  deployedValueUsd)`. Run `applyMarkPnl` with `backstopAvailable = backstop.balance()`; if
  `backstopCovered > 0` call `backstop.cover(bookId, seniorImpairmentBeforeCover)` and use the
  amount actually received. If `drawdownKill(drawdownBps, mandate.killAtDrawdownBps)` and not
  already killed → `mandate.kill("DRAWDOWN")`. Then for each tranche compute
  `price = sharePriceWad(trancheNav, totalSupply)` and call
  `tranche.settleAtMark(periodEnd / markInterval, price, topUpCapacity, vault)`; reduce S/J by
  `assetsOwed`, fund owed assets from vault idle to the tranche escrow (remainder → `unfundedClaims`);
  increase S/J by top-up accepted (cash moved escrow → vault). `registry.markApplied(markId)`.
  In **Retired** state redemption requests settle immediately at the final price.
- **Senior impairment follows the outstanding shares [ext]**: whenever Senior shares are burned at a
  settlement (redemption buckets at a mark, the Retired backlog, Retired immediate redemptions) the
  impairment is scaled pro-rata, `imp' = floor(imp · (supply − burned) / supply)` (0 once no Senior
  share is left). Holders who redeemed at the impaired price took their loss with them, so gain
  restoration and backstop cover (shared across books) only ever restore the remaining shares.
  Book-side only: `applyMarkPnl` and its TS mirror are unchanged.
- `creditDistribution` (only router): `S += senior; J += junior`.
- `onCapitalFlow()` (only vault): `flowNonce++`.
- `retire()` (only MarketCharter): Live → Retiring; cancels an open top-up round and calls
  `mandate.setRetiring()` **[ext]** — reduce-only wind-down, NOT a kill: desk keys stay active so the
  agent can flatten hedges, `ReturnToVault` desk USDC and recall the venue (no venue deploys, desk
  funding, hedge growth or risk-adding quotes). Best effort: a failing call emits
  `MandateKillFailed(bookId, "RETIRE")` and never blocks retirement. The drawdown kill at marks still
  applies while Retiring.
- `finalizeRetirement()`: Retiring and the last applied mark had `deployedValueUsd == 0` → Retired;
  `charter.onRetired(bookId)`.
- Sponsor skin: when the sponsor requests a Junior redemption that leaves them below 10% of Junior
  supply while Live, the request still succeeds (never gated) and the book emits `SponsorBelowSkin`
  and records `sponsorAbandoned = true` (committee may then `slashSponsor`).
- Book accounting invariant: `seniorNav + juniorNav` equals the last marked NAV (after flows) up to
  credited distributions/top-ups since; `unfundedClaims <= sum of owed`.

**Tranche** (`ITranche`, one implementation used for both kinds; ERC20 6-decimals, name
`"BKRN <SYMBOL> Senior"` / `"... Junior"`):

- Rounds: round 0 = subscription window (ends `book.subscriptionEnds()`); later rounds opened by
  `book.openTopUp` via `openRound(endsAt)`. `deposit(assets, receiver)` pulls USDC into the tranche
  escrow and records `committed[round][receiver] += assets`; per-wallet cap
  `charter.perWalletCapUsd` (0 = none; sponsor exempt); `DepositsClosed` outside a round or while
  paused or when `config.newBooksPaused()`.
- Window settlement: shares are minted to the tranche itself (escrow) in total = allocated; each
  wallet `claimAllocation(wallet)` → Senior: `walletAllocation(commit, totalCommitted, allocated)`;
  Junior: `juniorWindowAllocation(commit, wallet == sponsor, totalCommitted, sponsorWindowCommit,
  allocated)` (sponsor first, then pro-rata; `sponsorWindowCommit` snapshotted at `settleWindow`)
  shares transferred + refund USDC. Top-up rounds settle at the first mark whose period ends at or after
  the round end (`upToIndex * markInterval >= endsAt`; a round cannot be closed early): accepted = min(committed,
  capacity, senior-cap constraint for Senior), shares minted at that mark's price.
- Redemptions: `requestRedeem(shares, controller, owner)` transfers shares from owner (msg.sender
  must be owner or have allowance/operator) into escrow; bucket = `bucketIndex(eligibleAt,
  markInterval)` where eligibleAt = now (Senior) or now + juniorNoticeSeconds (Junior). Pending
  shares per (bucket, controller). `settleAtMark(upToIndex, price, ...)`: settles all buckets
  `lastSettled+1 .. upToIndex` that have shares at `price` (store price per bucket), burns shares,
  returns assets owed (sum over buckets of `floor(shares * price / 1e18)` computed per bucket).
  Claims compute per-controller `floor(controllerShares * bucketPrice / 1e18)`, never more than the
  bucket total. `claimRedemption`/`claimFor`/ERC-4626 `redeem`/`withdraw` on claimable amounts.
- **Invariant (red-team)**: requestRedeem and claims never revert for lack of permission — no pause,
  no allow-list, no state, no kill blocks them. Only `InsufficientLiquidity` may revert a claim.
- `pause()`/`unpause()`: GUARDIAN or the book's sponsor; blocks deposits only.
- ERC-4626 view surface (`asset`, `totalAssets` = tranche NAV, `convertToAssets/Shares` at last mark
  price, `maxDeposit` 0 outside rounds, `previewRedeem` reverts per ERC-7540).

**UnderwritingVault** (`IUnderwritingVault`): `deployToVenue(account, amount)` only book or desk;
approves adapter and calls `adapter.depositToVenue`; `recall` (book/desk/KEEPER/RISK) calls
`adapter.requestWithdraw`; `fundDesk` only desk; `payTo` only book (targets: its tranches only).
Every deploy/recall/fundDesk and desk `ReturnToVault` calls `book.onCapitalFlow()`.

### 2.6 MarketCharter, RiskCommittee, BookFactory [A-gov]

- `MarketCharter.file(c)`: `!newBooksPaused`; `msg.sender == c.sponsor`; `validate(c) == 0`; pulls
  `charterFeeUsd` USDC into escrow; `staking.lock(sponsor, bondLockId(id), sponsorBondBkrn)`;
  status Filed. `validate` reasons (bytes32 short strings): `IF_BELOW_VENUE_MIN`, `BAD_VENUE`,
  `BAD_ORACLE`, `BAD_BPS` (hurdle/cap > 1e4 or cap == 0), `BAD_WINDOW` (window < 60s or > 30d),
  `BAD_NOTICE` (> 30d), `BAD_MANDATE` (maxInventory == 0, minQuoteWidth == 0, band min > max,
  killAtDrawdownBps >= 0 or < -5000, maxSkewBps <= 0), `BAD_UNDERLYING` (not canonical token, not
  registered index), `BAD_SYMBOL` (zero), `BAD_FEES` (in-house taker fee > 100 bps).
- `decide(id, ok, juryCid)` only committee. Approve → fee forwarded to `expenseRecipient`
  (committee review + oracle setup), `factory.create(id, charter)`, record book, status Approved.
  Reject → fee refunded to sponsor, bond unlocked. `expire` after `committeeWindow`.
- `retire(bookId)`: sponsor or committee → `book.retire()`. `onRetired` (only that book) → unlock
  bond, status Retired. `slashSponsor` (committee, book flagged `sponsorAbandoned`) → staking.slash.
- `RiskCommittee`: per `IRiskCommittee` doc. `postJuryVerdict` only JURY role, once per charter.
  Votes only by bonded seated members, once per charter. Approve threshold: 2 approvals with a
  jury recommendation to approve, 3 if the jury recommended reject; reject threshold: 2 rejections.
  Finalizing calls `MarketCharter.decide`. Live-book actions (`proposeAction`/`approveAction`,
  2-of-3): kinds `REMANDATE` (data = abi.encode(Mandate)) → `mandate.remandate`, `RETIRE` →
  `charter.retire`, `SLASH_SPONSOR` → `charter.slashSponsor`, `REVOKE_KEY` → `mandate.revokeKey`.
  Member changes and `slashMember` only timelock.
- `BookFactory.create` (only MarketCharter): deploy per §IBookFactory doc; venue picks the adapter
  impl (Orderly or PoolEngine); registers the mandate clone as a staking locker; returns
  components; emits `BookCreated`. Implementations settable only by timelock (`ImplementationSet`).

### 2.7 MMMandate, BookrunnerDesk, HedgeExecutor, StockTokenRegistry [A-mandate]

**Mandate semantics (normative; TS mirror `packages/shared/src/mandate.ts`):**

| Field | Meaning | Enforced |
|---|---|---|
| `maxInventoryUsd` | max \|net venue position notional\| | engine: hard cap (`maxNetExposureUsd`); Orderly: risk monitor + venue position caps; key tier must be ≥ it |
| `maxSkewBps` | max \|quote mid − oracle\| / oracle | engine `checkQuote`; agent pre-trade; risk monitor |
| `minQuoteWidthBps` | min (ask − bid)/mid | engine `checkQuote` (spreadBps); agent; risk |
| `maxHedgeLeverage` | perp hedge legs, 0.01x units; spot = 100 | `checkHedge` |
| `hedgeRatioMin/MaxBps` | \|offsetting hedge\| / \|exposure\|; enforced when \|exposure\| ≥ 5% of maxInventory | `checkHedge`: post-trade in band OR strictly closer to band |
| `noNewRiskOffHours` | oracle `held` or stale ⇒ reduce-only | engine, `checkHedge` (must reduce \|exposure+hedge\|), `checkInventoryMove` (toVenue blocked), agent |
| `killAtDrawdownBps` | drawdown of perf index from high-water ≤ this ⇒ kill | book at mark (on-chain), risk intra-mark |
| `hedgeAllowRoot` | StandardMerkleTree over `(bytes32 asset, bytes32 venue)` | `checkHedge` with proof |

Spot Stock Tokens are long-only (not borrowable): a spot hedge can only offset a **short** venue
exposure; sells are capped by desk holdings (`SpotShortNotAllowed`). Post-trade holdings ≤
registry `floatCapRaw` (`FloatCapExceeded`). Venue exposure comes from `adapter.netExposureUsd()`;
for Orderly it is the last `report` and hedges that *add* hedge require `valuationAt` within
`config.maxPriceAge() * 4` (otherwise only reducing legs).

`checkInventoryMove(key, toVenue, account, amount)`: key active (and not killed) for toVenue;
IF: `insuranceEquity + amount <= charter.ifTargetUsd`; MM: `max(marginEquity,0) + amount <=
charter.mmInventoryUsd`; off-hours + noNewRiskOffHours blocks toVenue. Recalls (toVenue=false) are
always allowed to an active key, the RISK role, KEEPER and the book.
`FundDesk`: desk value after ≤ `maxInventoryUsd * hedgeRatioMaxBps / 1e4`.
`checkQuote`: spread ≥ minQuoteWidthBps, |skew| ≤ maxSkewBps, maxNetExposure ≤ maxInventoryUsd.

Keys: `registerKey` (sponsor) requires `inventoryTierUsd >= mandate.maxInventoryUsd` and locks
`config.agentTierBond(inventoryTierUsd)` from `operator` (lockId = keccak(bookId, key)) on
`config.staking()`, recorded as `bondStaking[key]`; revocation unlocks on that recorded staking (a
timelock repoint of `config.staking()` never strands a bond). `revokeKey` takes effect immediately (validation re-checks `isActiveKey` at both
`validateUserOp` and `execute` → key-revocation race is closed). `kill(reason)` (RISK or book):
`killed = true`, revoke all keys, set adapter reduce-only (engine), `book.onKill(reason)`.
`remandate` (committee) replaces terms and clears kill (keys must be re-registered).

**BookrunnerDesk** (`IBookrunnerDesk`), ERC-4337 v0.7 account. `execute(Action)` callable by
`config.entryPoint()` (after validation) or an active desk key; the RISK role may execute only
reduce-only kinds (`Flatten`, `InventoryToVault`, `ReturnToVault`). Action data encodings:

| Kind | `data` |
|---|---|
| Hedge | `abi.encode(address token, bool buy, uint256 amountIn, uint256 minAmountOut, uint24 poolFee, bytes32 venue)` — buy: USDC in; sell: token in |
| InventoryToVenue | `abi.encode(uint8 account, uint256 amount)` |
| InventoryToVault | `abi.encode(uint8 account, uint256 amount)` |
| FundDesk | `abi.encode(uint256 amount)` |
| ReturnToVault | `abi.encode(uint256 amount)` |
| SetQuote | `abi.encode(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd)` (engine books) |
| Flatten | `abi.encode(address token, uint256 amountIn, uint256 minAmountOut, uint24 poolFee, bytes32 venue)` — sells token → USDC |

Mark window: the capital-flow kinds (`InventoryToVenue`, `InventoryToVault`, `FundDesk`,
`ReturnToVault`) bump `book.flowNonce`, so a key's are refused (`MarkPending`) while a mark is pending —
book Live/Retiring and `max(lastMarkPeriodEnd, subscriptionEnds-if-unmarked) < block.timestamp rounded
down to markInterval` (the OrderlyAdapter sweep-gate rule; view `capitalFlowOpen()`). RISK is exempt.
A partial `ReturnToVault` must move >= 1 USDC (`MIN_RETURN_USD`); the whole balance always may.

`validateUserOp`: `ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(userOpHash), sig)` must be
an active key and `bytes4(callData) == execute.selector`. Gas policy (desk storage only, ERC-7562):
`(verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas <= maxOpCostWei` (default
0.01 ETH, else revert `OpCostTooHigh`); `missingAccountFunds` is drawn from `prefundBudgetWei`
(default 0, timelock `setGasPolicy`, else revert `PrefundBudgetExceeded`) and paid to the EntryPoint.
Timelock `withdrawDepositTo(to, amount)` recovers the EntryPoint deposit. Hedge notional = sum over
held canonical tokens of `registry.valueUsd(token, balance)`.

**HedgeExecutor**: `swapExactIn` for venue `UNIV3` via SwapRouter02; `UNIV4` reverts `NotConfigured`
until a v4 router is set (VERIFY U3). Router per venue settable by timelock. One side of every swap is
the settlement token (`config.usdc()`, `NotSettlementPair` otherwise); the pool(s) come from the
timelock-set **route** of the Stock Token side (`setRoute(venue, asset, fee, hop, hopFee)`): a direct
pool (`exactInputSingle`) or a two-pool path through `hop`, e.g. WETH (`exactInput`). The caller's
`poolFee` must be 0 (= the route) or the route's fee (`PoolFeeMismatch`); no route = `RouteNotSet`.
With `setV3Factory` set, `setRoute` on UNIV3 requires every pool to exist. The oracle-referenced
minimum is the desk's (per-swap `maxSlippageBps` + per-period budget on the oracle value given vs
received), on top of the caller's `minAmountOut`; pool depth is a pre-launch check
(`scripts/check-pools.ts`, VERIFY U4).

**StockTokenRegistry**: per `IStockTokenRegistry`. `valueUsd = qtyRaw * multiplierWad * priceWad /
(10**decimals * 1e18) / 1e12` (WAD USD → 6dp). Prices from `AttestedOracle.priceOf(priceId)` per
share of the equity — **the multiplier is applied exactly once** (red-team test). Index price ids
are oracle keys published by the oracle service as the weighted index level. Multiplier source per
token: stored, or (mainnet) the token's ERC-8056 `uiMultiplier()` read live within `multiplierBandBps`
of the stored anchor (`setMultiplierSource`, `setNextMultiplierAnchor`); Robinhood's per-token Chainlink
prices are divided by that same value in the oracle service (VERIFY C2/T2, `packages/shared/src/stockTokens.ts`).

### 2.8 AttestedOracle, PoolEngine, PoolEngineAdapter [A-engine]

- `AttestedOracle` per `IAttestedOracle` (EIP-712 typed price). `push` requires an active signer,
  `publishedAt > stored.publishedAt`, `publishedAt <= block.timestamp + 5`, and
  `sourceCount >= minSources` unless `held`. `priceOf` reverts `StalePrice` beyond `maxPriceAge`.
  Signer registry: timelock `setSigner(signer, active, attestation)`; the attestation hash is the
  TEE quote digest (verification flow VERIFY; devnet uses a plain key).
- `PoolEngine` per `IPoolEngine` (pool-vs-trader, isolated margin, aggregate accounting O(1)):
  - fill price: buy (trader long) at `oracle * (1e4 + spread/2 + skew) / 1e4`, sell at
    `oracle * (1e4 - spread/2 + skew) / 1e4` — skew (signed bps) shifts both sides; reverts if worse
    than `acceptablePriceWad`.
  - taker fee `takerFeeBps` of notional → `feesAccruedUsd` (claimed by the adapter → RevenueRouter).
  - every voluntary trade (open, increase, reduce, close, flip) needs a live price: none fills while
    the oracle is `held` (off-hours) or older than `min(maxPriceAge, 60 s, maxTradePriceAge)` (audit
    A2-01 / A2-03: a stale or held price would let a market-neutral pair close one leg at the old
    price and the other at the real one). New risk (|size| increases) is further blocked when the
    market is reduceOnly or the post-trade pool |net exposure| would exceed `maxNetExposureUsd`;
    initial margin check on new risk.
  - funding: skew-based, `rate/day = fundingVelocityBps * netSkew / maxNetExposure`, accrued on a
    cumulative index per unit size; paid by the crowded side to the pool's counterparty side; the
    pool's net funding is part of pool equity.
  - realised trader PnL settles against `poolCashUsd`; liquidation when margin ratio <
    maintenance — while the oracle is `held` (session closed) < `OFF_HOURS_MARGIN_MULTIPLE` (2) ×
    initial margin, capped at 100 % (audit A2-02: a position held through the close must absorb a
    reopen gap of that size, else it is liquidated at the held close rather than leaving the gap as IF
    bad debt; traders top up or deleverage before the close, top-ups work off-hours). Liquidations
    use the latest (held) price with no `maxTradePriceAge` bound (involuntary, fee-bearing); position
    closed at oracle, `liquidationFeeBps` split 50% liquidator / 50% IF; wind-down `forceClose`
    (anyone, once the close-out is open) instead needs a live, fresh price like a trade (optionally
    carried as `priceData`), so it never fills at a held price;
    bad debt paid by IF, then **ADL within that market only** (pool cash reduced by shortfall,
    `ADL` event) — never touches other markets.
  - `withdrawLiquidity` keeps `poolEquity - amount >= requiredPoolMargin` (pool must cover current
    trader unrealised PnL).
- `PoolEngineAdapter` (UUPS): `initialize` creates the market from the charter
  (`MarketConfig{underlying=priceId, symbol, takerFeeBps, makerFeeBps, initialMargin 1000,
  maintenance 500, liquidationFee 50, fundingVelocity 100, maxNetExposure = mandate.maxInventoryUsd}`).
  `depositToVenue(IF|MM)` → engine insurance / liquidity; `requestWithdraw` is synchronous (funds to
  vault in the same call); `sweepFees` (anyone) claims engine fees → RevenueRouter
  (`notifySettlement(SRC_ENGINE_FEES, amount)`); `setQuote` only desk; `setReduceOnly` desk/RISK/
  mandate. `netExposureUsd` = engine pool exposure; `deployedValueUsd = insurance + max(poolEquity,0)`.

### 2.9 OrderlyAdapter, MockOrderlyVault [A-orderly]

- `OrderlyAdapter` (UUPS): holds the book's two Orderly accounts. Orderly allows one account per (address,
  broker) (`keccak256(abi.encode(owner, brokerHash))`), so MM = the adapter's own account and IF = the account
  of a per-book `OrderlyIFAccount` contract the adapter deploys at `initialize` (CREATE2, salt = bookId);
  `accountOwner(account)` returns the owner (deposit receiver, `delegateContract` of keys and withdrawals, payout
  address). The IF contract only registers the delegate signer and forwards its balance to the adapter, which
  pulls it before every sweep / fee forward. Pre-v3 proxies keep the devnet derivation
  `keccak256(abi.encode(adapter, brokerHash, account))` until `migrateToOrderlyAccounts()` (timelock).
  `depositToVenue` → `IOrderlyVault.deposit` (MM) / `depositTo(ifAccount, ...)` (IF) (approve exact amount;
  native fee `getDepositFee(owner, ...)` from the adapter's ETH, topped up via `fundNative`, else
  `InsufficientNativeForFee`). The settlement token is `config.usdc()` (USDC devnet, USDG on RHC; 6 decimals
  enforced, listed by the Vault under `tokenHash`). `requestWithdraw` emits `WithdrawRequested(nonce)` and tracks
  `inTransit`; ops-venue executes it on Orderly then `confirmWithdraw(nonce)`; returned USDC is swept
  by `sweepToVault`. **No function can send USDC anywhere except the vault and the RevenueRouter.**
  `report` (OPS_VENUE) stores IF/MM equity + exposure + asOf (monotonic). `sweepFees(period,
  amount)` (OPS_VENUE): once per period, `amount <= maxFeeSweepPerPeriodUsd` (default 2% of
  `ifTargetUsd + mmInventoryUsd` per period, settable by timelock) → RevenueRouter
  (`SRC_VENUE_TAKER_SHARE`). `setDelegateSigner` (timelock) → `IOrderlyVault.delegateSigner` for the
  adapter and its IF account (one EOA signs for both; Orderly pays contract accounts only to themselves).
  **[ext] Withdrawal/report protocol** (each USDC counted once in any payout/confirm order):
  Requested = still venue-side; a payout landing before `confirmWithdraw` is *held* on the adapter
  (never swept as unattributed nor forwarded as fees); `report` reverts `WithdrawalPending` while any
  request is Requested; ops-venue confirms as soon as the venue has debited the account (before the
  payout), cancels requests the venue will not execute, and reports raw venue equity (net of executed
  withdrawals) only once the venue has credited every on-chain deposit (`asOf > lastFlowAt`, which
  deposit/confirm/cancel/fail set). Only principal sweeps notify the vault (`flowNonce++`).
  `sweepFees` labels are monotonic and at most `FEE_SWEEP_LOOKBACK_PERIODS` (2) intervals old; the
  earmark must precede the fee payment to the adapter.
- `MockOrderlyVault`: implements `IOrderlyVault` on devnet; ledger of deposits per accountId;
  `operatorWithdraw(accountId, to, amount)` callable by an operator (ops-venue) to simulate Orderly
  paying a withdrawal; `creditFees(accountId, amount)` for simulated builder fee settlement (USDC
  minted by the mock USDC or pre-funded). Emits events the mock-orderly REST server reads.

### 2.10 Red-team checks (Backend §2.9) — required tests

Waterfall ordering under partial losses (fuzz) · redemption always honoured (invariant: no
permission revert — handler tries requestRedeem/claim under pause, kill, Retiring, Retired,
guardian pause) · mandate escalation (key cannot raise its own limits / call non-typed actions) ·
key revocation race (revoke then execute in same block → revert) · off-hours quoting blocked
(engine trades incl. closes + desk SetQuote widening + hedge adding risk) · oracle staleness → engine
pause for every trade (liquidate still works) · Stock Tokens not borrowable (sell > held
reverts) · float caps · multiplier double-apply (valuation with multiplier 2e18 equals exactly 2×;
live `uiMultiplier` + per-token feed ⇒ value = qty × feed, `MULTIPLIER_VECTOR`).
Plus A10 invariants: redemption never permission-gated; waterfall conservation (S + J == marked
NAV + backstop cover after every applyMark, modulo credited flows); mandate bounds (engine pool
|net exposure| ≤ maxInventoryUsd always).

---

## 3. Flows (end to end)

1. **Charter → book**: sponsor `staking.stake` + approve fee → `MarketCharter.file` → charter
   service enqueues jury → jury verdict JSON → CID (sha2-256, CIDv1 raw) → `postJuryVerdict` →
   members vote (2-of-3) → `decide` → `BookFactory.create` → window opens (`subscriptionEnds = now +
   subscriptionWindow`).
2. **Subscription**: allocators `tranche.deposit` (Senior/Junior) → after `subscriptionEnds`
   anyone `book.closeWindow()` (keeper does) → allocation pro-rata (Junior: sponsor first, capped at
   10× the sponsor) → sponsor Junior commitment check →
   IF + MM deployed → ops-venue creates the symbol (Orderly) / engine market is live.
3. **Quote/hedge**: agent streams quotes within mandate (Avellaneda-Stoikov with inventory skew,
   clamped to mandate); hedge planner keeps the ratio in band via desk `Hedge` actions (long spot
   via UNIV3) and/or offsetting perps on allow-listed venues; off-hours → reduce-only.
4. **Breach/kill**: risk detects utilisation > 100%, quote out of bounds, drawdown ≤ kill, or hedge
   band breach past grace → venue cancel-all → flatten within mandate (RISK desk `Flatten`,
   reduce-only quotes) → revoke venue trade key (ops-venue) + `mandate.kill` (revokes desk keys) →
   sponsor notified (webhook `kill.executed`) → committee may `REMANDATE`.
5. **Each mark period** (`markInterval`): ops-venue reports (Orderly) → waterfall service sweeps fees
   (`adapter.sweepFees`) and `router.distribute(period)` → keeper recalls venue liquidity if queued
   redemptions exceed vault idle → mark service computes NAV, inventory root, receipts root, PnL
   JSON → signs + `MarkRegistry.commit` → `book.applyMark` → tranche NAVs update, redemptions
   honoured → `mark.committed` / `distribution.paid` webhooks.
6. **Wind-down**: `retire(bookId)` → `mandate.setRetiring()` (keys stay, reduce-only) → agent stops
   quoting, flattens hedges and returns desk USDC (`ReturnToVault`) → keeper recalls IF + MM
   (venue rules) → final mark with `deployedValueUsd == 0` → `finalizeRetirement` → full redemption.

---

## 4. Services (TypeScript, Bun)

Common: each service is `services/<name>` with `package.json` (`@bookrunner/<name>`, scripts
`start`, `dev`, `test`, `typecheck`), `src/index.ts` entry, config via `loadEnv` from
`@bookrunner/shared`, logs via `createLogger`, DB via `createDb` from `@bookrunner/db`, Redis via
`ioredis` 6, queues via BullMQ 6, chain via viem 2 + ABIs from `@bookrunner/shared/abi`, addresses
via `loadDeployment()`. Every service must start and idle cleanly when the deployment file is
missing (log + retry) and must expose `GET /health` on its own port when it runs an HTTP server.
Unit tests with `bun test` must not require running infra (inject fakes); integration tests may,
guarded by `process.env.BKRN_IT === "1"`.

| Service | Port | Responsibilities |
|---|---|---|
| `oracle` | 4410 | Price sources (devnet: deterministic GBM per ticker seeded by ticker + optional live HTTP sources behind VERIFY flags; Chainlink feed reader when configured), multi-source median (min 3 sources unless held), session calendar → `held`, index levels (weighted components), EIP-712 sign → `AttestedOracle.pushMany` every N seconds, publish `OraclePriceMsg` to Redis + `oracle_prices`. TEE attestation is VERIFY: expose `/attestation` returning the signer + placeholder quote. Also pushes builder prices to the venue (mock-orderly `/mock/price`). |
| `ops-venue` | — | Orderly builder flow (live client behind `ORDERLY_MODE=live`, VERIFY endpoints) + mock client; jobs: create_symbol after window close, fund IF / deposit MM accounting, execute withdrawals (`WithdrawRequested` → venue → `confirmWithdraw` → `sweepToVault`), periodic `adapter.report`, fee settlement withdrawal + `sweepFees(period)`, revoke trade keys on kill. Splits trade-only and builder keys; stores only key prefixes in `venue_accounts`. Exports `OrderlyVenue` (`QuotingVenue`) for agent/risk from `services/ops-venue/src/client.ts`. |
| `mock-orderly` | 4420 | Local Orderly REST simulator (§`packages/shared/src/orderly.ts` paths): accounts, resting quotes, simulated taker flow that crosses the book's quotes stochastically, positions/equity marked at builder price, builder fee share = 50% of base taker fees settled per period, IF balances, withdrawals paid through `MockOrderlyVault.operatorWithdraw`. ed25519 auth verified when keys are configured; permissive in dev. |
| `bookrunner-agent` | — | One process per book (`BOOK_ID`). Avellaneda-Stoikov quoting: reservation price `r = s − q·γ·σ²·τ`, spread `δ = γσ²τ + (2/γ)ln(1+γ/k)`, then clamp to mandate (width ≥ min, |skew| ≤ max, sides per `allowedSides`). Venues: `OrderlyVenue` or `EngineVenue` (desk SetQuote). Hedge planner: keep `hedgeRatioBps` in band using desk `Hedge`/`Flatten` (signed with the session key, direct `execute` tx on devnet; userOp path for bundlers). Kill logic: on `CHANNELS.kill` or mandate killed → cancel-all and stop. Writes quotes/fills/hedges to DB (+ receipts leaves), heartbeat in Redis. Includes `trader-sim` entry (`src/trader-sim.ts`) generating taker flow on the engine and mock venue. |
| `risk` | — | Every few seconds per live book: read venue exposure (adapter / venue API), desk hedge, last quote, live NAV estimate → `classifyLimits` → write `limits` row + Redis state; transitions emit `limit.breached`; breach → kill sequence (§3.4) with `kill_events` row and `kill.executed`. Off-hours flags from oracle held/stale. Drawdown intra-mark from live NAV vs book high-water. Exports nothing; consumes `QuotingVenue`. |
| `mark` | — | Per book per period: wait for distribution of the period (or timeout), recall-if-needed check, compute NAV components (vault idle, adapter equity/in-transit, desk USDC + hedge value via registry), inventory tree, receipts root over hourly roots of the period, `MarkPnl` JSON (canonical, hash), sign EIP-712, `commit`, `applyMark`, persist `marks`, emit `mark.committed`. Uses archive-style reads at a fixed block. |
| `waterfall` | — | Per book per period: Orderly → enqueue ops-venue sweep, then wait (bounded, `WATERFALL_FEE_FORWARD_WAIT_SECONDS`) for the earmarked fees to reach the router via `forwardPendingFees`; engine → `adapter.sweepFees`; then `router.distribute(period, expenses)` with expenses from oracle/keeper gas accounting (devnet: fixed small amount, capped on-chain); persist `settlements`; emit `distribution.paid`. Also keeper duties: `closeWindow` when due, `fundClaims`, `finalizeRetirement`, and once per pass `BkrnFeeRouter.executeBuyback` when `buybackPending` ≥ `WATERFALL_BUYBACK_THRESHOLD_USD` (amountIn capped at `maxBuybackPerCall`; minBkrnOut = max(buyback router quote − `WATERFALL_BUYBACK_SLIPPAGE_BPS`, on-chain `buybackFloor`); a quote below the floor is skipped). |
| `receipts` | — | Hourly (devnet: `RECEIPTS_INTERVAL_SECONDS`) per book: StandardMerkleTree over `receipts` leaves in the window → `receipt_roots`; proof API helpers. Leaves are written by agent (quotes, fills, hedges), risk (decisions), charter (decisions). |
| `charter` | 4430 | Intake API (validated charter drafts → prepared tx), indexing of `CharterFiled`, model jury: N models (Claude via `@anthropic-ai/sdk` when `ANTHROPIC_API_KEY`, models from `JURY_MODELS`) each return structured `{vote, rationale, risks[]}` given the charter + rule checks; majority → recommendation; deterministic rule-based jury fallback without a key. Verdict JSON → CIDv1 (raw, sha2-256 via `multiformats`) → `postJuryVerdict(digest)`; committee notifications (`committee` table, events). |
| `indexer` | — | Chain → DB: watches all protocol events from `deployment.startBlock` with a `chain_cursor` (reorg-safe with N confirmations on mainnet, 0 on devnet): charters, books, subscriptions, redemptions, marks, settlements, desk keys, kills, committee votes. Emits internal domain events. |
| `api` | 4400 | Hono + tRPC v11 (`/trpc`) + REST mirror (`/v1/...`) + webhooks + read-only MCP (`/mcp`, Streamable HTTP). Procedures (Backend §5): `charter.file/get/list/decide`, `book.list/get/nav/limits/marks/fills/hedges`, `tranche.subscribe/redeem(notice)`, `agent.register/revoke(bookId, key)`, `risk.state(bookId)`, `settlements.list`, `receipts.list/root/proof` (activity feeds `book.fills/hedges` and `receipts.list`: newest first, `limit` 1..200 default 50, `cursor` = previous `nextCursor`). Mutations that are on-chain return **prepared transactions** (`{to, data, value, chainId}`) for the user's wallet; `charter.decide` = committee vote tx. Webhooks: subscriptions CRUD + HMAC-signed delivery with retries (events: charter.decided, limit.breached, kill.executed, mark.committed, distribution.paid). MCP tools: `book_nav`, `book_limits`, `charters` (read-only). |

Queues/channels/keys: `packages/shared/src/queues.ts`. Events: `packages/shared/src/events.ts`.
Data model: `packages/db/src/schema.ts` (tables of Backend §4 plus extensions).

## 5. Web (apps/web)

Vite + React 19 + TanStack Query + tRPC client + Tailwind 4 + viem/wagmi (injected wallet; devnet
"dev wallet" picker using anvil keys for demo). Pages: Books (table: book, venue, state, NAV,
Senior/Junior NAV per share, limits state), Book detail (NAV + tranche chart from marks, waterfall
of the last distribution, live quote + inventory, limit gauges, fills/hedges, marks with receipts
roots and "verify proof", one invest panel to deposit, withdraw and collect), Charters (file form with mandate
editor, status, jury verdict, committee votes), Committee (vote), Risk (all books' limit states,
kill log), Docs/legal footer ("Bookrunner is software; not a fund, adviser, broker or venue operator
of record"; "Not available to US persons"). Copy rules: §6.

## 6. Copy rules (Overview §10, enforced by `scripts/check-copy.ts`)

Banned in user-facing copy: APY/APR, yield, returns, target, guaranteed, protected, insured,
risk-free, "we market-make for you", naming Orderly/Arcus/Chainlink as partners, US marketing of
stock-perp books, sibling studio products. Use: "fee flow", "observed accrual over the mark period",
"NAV", "last loss in the waterfall", "backstop up to the pool", "bookrunner agents quote the book
under its mandate", "listed on X's public contracts". Tranches are described by seniority and loss
order only — never by rates.

## 7. Devnet launch (Lane C1)

Three studio-sponsored books (sponsor = anvil #7, committee #8–#10, agent operator #11):

| Book | Underlying | Venue | IF | MM | Mandate (maxInv / skew / width / band / kill) |
|---|---|---|---|---|---|
| NVDA | Stock Token NVDA (mult 1.0) | Orderly (mock) `PERP_NVDA_USDC` | 25,000 | 75,000 | 50k / 25 / 8 / 5000–12000 / −800 |
| TSLA | Stock Token TSLA (mult 1.0) | Orderly (mock) `PERP_TSLA_USDC` | 25,000 | 75,000 | 50k / 30 / 12 / 5000–12000 / −800 |
| RHX5 | index of NVDA, TSLA, AAPL, MSFT, AMZN (20% each) | in-house PoolEngine `RHX5-PERP` | 25,000 | 100,000 | 75k / 25 / 10 / 4000–12000 / −800 |

Senior cap 7000, Senior share of fee flow 6000, window 10 min, junior notice 15 min (devnet),
per-wallet cap 250k. Demo prices (WAD, devnet only): NVDA 190, TSLA 440, AAPL 255, MSFT 520,
AMZN 230. Hedge allow-lists: each token on UNIV3 (index: all five).

## 8. VERIFY register (see docs/VERIFY.md)

Orderly Vault address/ABI on RHC, accountId derivation, IF account mechanics, builder endpoints,
symbol naming, fee settlement cadence and minimum IF; Uniswap v3/v4 routers + Stock Token pools on
RHC; EntryPoint v0.7 on RHC; Chainlink equity feed addresses; USDC/USDG addresses; Stock Token
addresses/multipliers; RHC RPC (Dwellir archive) and chain id 4663; TEE attestation verification.
