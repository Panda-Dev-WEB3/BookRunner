// Why a transaction would fail, in plain words. The testnet RPC returns custom errors without a
// reason string ({"code":3,"message":"execution reverted","data":"0xfb8f41b2..."}), so the revert
// data is found in the error chain and decoded against the custom errors the investor flows can hit
// (ITranche, Tranche, BkrnStaking, OpenZeppelin ERC20). Pure (test/revert.test.ts).
import { type Hex, decodeErrorResult, parseAbi } from "viem";
import { BKRN_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "./amount";
import { fmtWhen } from "./format";
import { getSettlementSymbol } from "./settlementToken";

export const REVERT_ABI = parseAbi([
  "error InsufficientLiquidity(uint256 needed, uint256 available)",
  "error DepositsClosed()",
  "error WalletCapExceeded(uint256 cap, uint256 attempted)",
  "error ExceedsClaimable(uint256 requested, uint256 claimable)",
  "error NotAuthorized()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error GuardianPaused()",
  "error RoundNotSettled()",
  "error InsufficientAvailable(uint256 available, uint256 requested)",
  "error NothingPending()",
  "error CooldownActive(uint64 availableAt)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error EnforcedPause()",
]);

const isRevertData = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v);

/** The first revert payload (selector + args) anywhere in an error's cause / data chain. */
export function findRevertData(e: unknown, depth = 0): Hex | null {
  if (depth > 8 || e == null || typeof e !== "object") return null;
  const o = e as { data?: unknown; cause?: unknown; error?: unknown; originalError?: unknown };
  if (isRevertData(o.data)) return o.data;
  for (const next of [o.data, o.originalError, o.error, o.cause]) {
    const found = findRevertData(next, depth + 1);
    if (found) return found;
  }
  return null;
}

const usdc = (v: unknown) => `${formatAmountDisplay(typeof v === "bigint" ? v : 0n, USDC_DECIMALS)} ${getSettlementSymbol()}`;
const bkrn = (v: unknown) => `${formatAmountDisplay(typeof v === "bigint" ? v : 0n, BKRN_DECIMALS)} BKRN`;

/** Plain-language reason for a decoded custom error (null for an unknown one). */
export function revertMessage(name: string, args: readonly unknown[] = []): string | null {
  switch (name) {
    case "InsufficientLiquidity":
      return `The book has not moved enough ${getSettlementSymbol()} to the tranche yet (${usdc(args[0])} needed, ${usdc(args[1])} available): its cash is still on the venue. Collecting waits until the keeper brings it back; try again after the next mark.`;
    case "DepositsClosed":
      return "Deposits into this tranche are closed right now: the round has ended or deposits are paused. Review the deposit again.";
    case "WalletCapExceeded":
      return `This is above the per-wallet cap for this round (${usdc(args[0])}).`;
    case "ExceedsClaimable":
      return `Only ${usdc(args[1])} can be collected right now.`;
    case "NotAuthorized":
      return "This wallet is not allowed to act for that account. Switch back to the wallet that prepared the transaction.";
    case "ZeroAmount":
      return "The amount is zero.";
    case "ZeroAddress":
      return "A required address is missing.";
    case "GuardianPaused":
    case "EnforcedPause":
      return "The protocol guardian has paused this action. Withdrawals and claims are never blocked by a pause.";
    case "RoundNotSettled":
      return "The round has not settled yet.";
    case "InsufficientAvailable":
      return `Only ${bkrn(args[0])} is free to use (the rest is locked as a bond or already cooling down).`;
    case "NothingPending":
      return "There is no unstake request to withdraw or cancel.";
    case "CooldownActive":
      return `The unstake cooldown is still running, until ${fmtWhen(typeof args[0] === "bigint" ? Number(args[0]) : Number(args[0] ?? 0))}.`;
    case "ERC20InsufficientAllowance":
      return "The token allowance is too low for this amount. Run the approval step first, then this one.";
    case "ERC20InsufficientBalance":
      return "The wallet does not hold enough of the token for this amount.";
    case "Error":
      return typeof args[0] === "string" && args[0] ? `The transaction would fail on-chain: ${args[0]}.` : null;
    default:
      return null;
  }
}

/** Plain reason a call reverted, decoded from the error chain; null when no revert data is found. */
export function revertReason(e: unknown): string | null {
  const data = findRevertData(e);
  if (!data) return null;
  try {
    const d = decodeErrorResult({ abi: REVERT_ABI, data });
    return revertMessage(d.errorName, (d.args ?? []) as readonly unknown[]) ?? `The transaction would fail on-chain (${d.errorName}).`;
  } catch {
    return `The transaction would fail on-chain (error ${data.slice(0, 10)}).`;
  }
}
