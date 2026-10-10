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
- [ ] VERIFY O6 (Orderly accountId) and O9 (withdraw receiver): the OrderlyAdapter implementation in the repo
      maps MM / IF to real Orderly accounts (pending package: OrderlyAdapter account ids / IF receiver). Until
      then do not charter Orderly books (PoolEngine books are unaffected).
- [ ] VERIFY C2: the oracle service publishes per-share prices (Chainlink RHC feeds are per token, multiplier
      included) — pending package: oracle sources.
- [ ] VERIFY E1: TEE platform chosen, attestation digest of each oracle signer known (input `oracle.signers`).
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
       and every component, sets params / oracle signers / Stock Tokens / indexes / implementations / buyback /
       staking / backstop, grants the service roles to the input's addresses and GUARDIAN to the guardian,
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
         EntryPoint as input; all 8 factory implementations set; OrderlyAdapter hashes == input;
       - params, tiers, venue minimum IF (> 25,000e6 for Orderly), staking cooldown (>= 1 day) / rewards
         duration, backstop cap, buyback router (SwapRouter02) + params, HedgeExecutor routers, oracle signers
         + attestations + minSources, Stock Tokens + indexes all equal to the input.
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

## Operations

- **Kill switch for new business**: `BookrunnerConfig.setNewBooksPaused(true)` (GUARDIAN or timelock)
  — pauses new charters, books and deposits. Redemptions keep working; there is no switch for them.
- **Re-mandate after a kill**: committee `proposeAction(bookId, "REMANDATE", abi.encode(mandate))`,
  2-of-3 approve; the sponsor re-registers desk keys.
- **Mark reconciliation break** (Day-30 kill criterion): freeze new charters until clean; compare the
  mark's `pnl_json` venue section against the venue statement for the period.
- **Wind-down**: `MarketCharter.retire(bookId)` → agents flatten → keeper recalls IF + MM → final
  mark with zero deployed value → `finalizeRetirement` → every holder redeems at the final NAV.

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
