// Prepared transactions for filing a charter from the sponsor's wallet (ARCHITECTURE §3.1):
//   [BKRN.approve(staking) + staking.stake(shortfall)] if the free stake is below the sponsor bond,
//   [USDC.approve(charter, fee)] if the allowance is short, then MarketCharter.file(c).
import { type Charter, formatFixed, formatUsd } from "@bookrunner/shared";
import { bkrnStakingAbi, marketCharterAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, erc20Abi } from "viem";

export interface PreparedTx {
  kind: "approve_bkrn" | "stake_bkrn" | "approve_usdc" | "file";
  description: string;
  from: Address;
  to: Address;
  data: Hex;
  value: string; // wei, decimal string
  chainId: number;
}

export interface SponsorState {
  sponsorBondBkrn: bigint; // config.sponsorBondBkrn()
  charterFeeUsd: bigint; // config.charterFeeUsd()
  stakingAvailable: bigint; // staking.availableOf(sponsor)
  bkrnBalance: bigint;
  bkrnAllowanceToStaking: bigint;
  usdcBalance: bigint;
  usdcAllowanceToCharter: bigint;
  newBooksPaused: boolean;
}

export interface FilingAddresses {
  bkrn: Address;
  staking: Address;
  usdc: Address;
  charter: Address;
}

/** viem-ready Charter tuple for MarketCharter.file / validate. */
export function charterArg(c: Charter) {
  return {
    underlying: c.underlying,
    venue: c.venue,
    oracle: c.oracle,
    sessions: c.sessions,
    ifTargetUsd: c.ifTargetUsd,
    mmInventoryUsd: c.mmInventoryUsd,
    mandate: { ...c.mandate },
    seniorHurdleBps: c.seniorHurdleBps,
    seniorCapBps: c.seniorCapBps,
    subscriptionWindow: c.subscriptionWindow,
    juniorNoticeSeconds: c.juniorNoticeSeconds,
    sponsor: c.sponsor,
    perWalletCapUsd: c.perWalletCapUsd,
    symbol: c.symbol,
    takerFeeBps: c.takerFeeBps,
    makerFeeBps: c.makerFeeBps,
  } as const;
}

const charterInput = (() => {
  const fn = marketCharterAbi.find((x) => x.type === "function" && x.name === "file");
  if (!fn || fn.type !== "function") throw new Error("MarketCharter ABI has no file()");
  return fn.inputs;
})();

/** ABI-encoded BRTypes.Charter (the struct as a single tuple parameter). */
export function encodeCharter(c: Charter): Hex {
  return encodeAbiParameters(charterInput, [charterArg(c)]);
}

export function fileCalldata(c: Charter): Hex {
  return encodeFunctionData({ abi: marketCharterAbi, functionName: "file", args: [charterArg(c)] });
}

export function prepareFilingTxs(
  c: Charter,
  state: SponsorState,
  addrs: FilingAddresses,
  chainId: number,
): { transactions: PreparedTx[]; warnings: string[] } {
  const from = c.sponsor;
  const txs: PreparedTx[] = [];
  const warnings: string[] = [];
  const base = { from, value: "0", chainId };

  if (state.newBooksPaused) warnings.push("new books are paused by the guardian: MarketCharter.file will revert until unpaused");

  const stakeShortfall = state.sponsorBondBkrn > state.stakingAvailable ? state.sponsorBondBkrn - state.stakingAvailable : 0n;
  if (stakeShortfall > 0n) {
    if (state.bkrnBalance < stakeShortfall) {
      warnings.push(`BKRN balance ${formatFixed(state.bkrnBalance, 18)} is below the ${formatFixed(stakeShortfall, 18)} BKRN still needed for the sponsor bond`);
    }
    if (state.bkrnAllowanceToStaking < stakeShortfall) {
      txs.push({
        ...base,
        kind: "approve_bkrn",
        description: `Approve ${formatFixed(stakeShortfall, 18)} BKRN to staking`,
        to: addrs.bkrn,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addrs.staking, stakeShortfall] }),
      });
    }
    txs.push({
      ...base,
      kind: "stake_bkrn",
      description: `Stake ${formatFixed(stakeShortfall, 18)} BKRN (sponsor bond ${formatFixed(state.sponsorBondBkrn, 18)} BKRN is locked at filing)`,
      to: addrs.staking,
      data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "stake", args: [stakeShortfall] }),
    });
  }

  if (state.usdcBalance < state.charterFeeUsd) {
    warnings.push(`USDC balance ${formatUsd(state.usdcBalance)} is below the charter fee ${formatUsd(state.charterFeeUsd)}`);
  }
  if (state.usdcAllowanceToCharter < state.charterFeeUsd) {
    txs.push({
      ...base,
      kind: "approve_usdc",
      description: `Approve the ${formatUsd(state.charterFeeUsd)} USDC charter fee (refunded on rejection)`,
      to: addrs.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addrs.charter, state.charterFeeUsd] }),
    });
  }

  txs.push({ ...base, kind: "file", description: "File the charter with MarketCharter", to: addrs.charter, data: fileCalldata(c) });
  return { transactions: txs, warnings };
}
