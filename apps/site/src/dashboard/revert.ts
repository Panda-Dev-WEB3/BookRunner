// Why a transaction would fail, in plain words. The testnet RPC returns custom errors without a
// reason string, so the revert data is found in the error chain and decoded against every custom
// error of the contracts this desk calls. Pure (test/revert.test.ts).
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { bookAbi } from "@bookrunner/shared/abi/Book";
import { marketCharterAbi } from "@bookrunner/shared/abi/MarketCharter";
import { mMMandateAbi } from "@bookrunner/shared/abi/MMMandate";
import { mockERC20Abi } from "@bookrunner/shared/abi/MockERC20";
import { riskCommitteeAbi } from "@bookrunner/shared/abi/RiskCommittee";
import { trancheAbi } from "@bookrunner/shared/abi/Tranche";
import { type Abi, type Hex, decodeErrorResult } from "viem";
import { BKRN_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "./amount";
import { settlementSymbol } from "./token";
import { dateTime } from "./format";

type AbiItem = Abi[number];

/** Every custom error of the contracts the desk sends to (deduplicated by name + inputs). */
export const ERRORS_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: AbiItem[] = [];
  for (const abi of [trancheAbi, bookAbi, bkrnStakingAbi, mMMandateAbi, marketCharterAbi, riskCommitteeAbi, mockERC20Abi] as unknown as Abi[]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
})();

const isRevertData = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v);

/** The first revert payload (selector + args) anywhere in an error's cause / data chain. */
export function findRevertData(e: unknown, depth = 0): Hex | null {
  if (depth > 8 || e == null || typeof e !== "object") return null;
  const o = e as { data?: unknown; cause?: unknown; error?: unknown; originalError?: unknown };
  if (isRevertData(o.data)) return o.data;
  if (o.data && typeof o.data === "object" && isRevertData((o.data as { data?: unknown }).data)) return (o.data as { data: Hex }).data;
  for (const next of [o.data, o.originalError, o.error, o.cause]) {
    const found = findRevertData(next, depth + 1);
    if (found) return found;
  }
  return null;
}

const usdc = (v: unknown) => `${formatAmountDisplay(typeof v === "bigint" ? v : 0n, USDC_DECIMALS)} ${settlementSymbol()}`;
const bkrn = (v: unknown) => `${formatAmountDisplay(typeof v === "bigint" ? v : 0n, BKRN_DECIMALS)} BKRN`;

/** Plain-language reason for a decoded custom error (null for one without a dedicated message). */
export function revertMessage(name: string, args: readonly unknown[] = []): string | null {
  switch (name) {
    case "InsufficientLiquidity":
      return `The book has not moved enough ${settlementSymbol()} to the tranche yet (${usdc(args[0])} needed, ${usdc(args[1])} available): its cash is still on the venue. Try again after the next mark.`;
    case "DepositsClosed":
      return "Deposits into this tranche are closed: no subscription window or top-up round is open, or deposits are paused.";
    case "WalletCapExceeded":
      return `This is above the per-wallet cap for this round (${usdc(args[0])}).`;
    case "ExceedsClaimable":
      return `Only ${usdc(args[1])} can be collected right now.`;
    case "NotAuthorized":
    case "Unauthorized":
      return "This wallet is not allowed to do this. On-chain permissions decide: switch to the wallet that holds the role.";
    case "NotSponsor":
      return "Only the book's sponsor wallet can do this.";
    case "NotMember":
    case "NotBondedMember":
      return "This wallet does not hold a bonded Risk Committee seat.";
    case "AlreadyVoted":
      return "This committee member has already voted on the charter.";
    case "CharterNotOpen":
    case "WrongStatus":
      return "The charter is no longer open for this action.";
    case "TopUpActive":
      return "A top-up round is already open for this book.";
    case "BadTopUp":
      return "The round needs a window above zero (within the maximum) and a capacity above zero for at least one tranche.";
    case "BadState":
      return "The book is not in a state that allows this (a top-up round needs a Live book).";
    case "NewBooksPaused":
    case "GuardianPaused":
    case "EnforcedPause":
      return "The protocol guardian has paused this action. Redemptions and claims are never blocked by a pause.";
    case "ZeroAmount":
      return "The amount is zero.";
    case "ZeroAddress":
      return "A required address is missing.";
    case "RoundNotSettled":
      return "The round has not settled yet: it settles at the first mark on or after the round end.";
    case "InsufficientAvailable":
      return `Only ${bkrn(args[0])} is free to use (the rest is locked as a bond or already cooling down).`;
    case "NothingPending":
      return "There is no unstake request to withdraw or cancel.";
    case "CooldownActive":
      return `The unstake cooldown is still running, until ${dateTime(Number(args[0] ?? 0))}.`;
    case "OperatorConsentMissing":
      return "The operator has not consented to this key yet: the operator wallet signs the consent step first.";
    case "TierBelowMandate":
      return "The inventory tier must be at least the mandate's maximum inventory.";
    case "TierBondMissing":
    case "NoBond":
      return "The operator does not have enough BKRN staked and free to bond this tier.";
    case "KeyAlreadyActive":
      return "This key is already active on the desk.";
    case "MandateKilled":
      return "The mandate is killed: the committee must re-mandate before keys can be registered.";
    case "TooManyKeys":
      return "The desk already has the maximum number of active keys.";
    case "ERC20InsufficientAllowance":
      return "The token allowance is too low for this amount. Run the approval step first.";
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
    const d = decodeErrorResult({ abi: ERRORS_ABI, data });
    return revertMessage(d.errorName, (d.args ?? []) as readonly unknown[]) ?? `The transaction would fail on-chain (${d.errorName}).`;
  } catch {
    try {
      const d = decodeErrorResult({ data });
      return revertMessage(d.errorName, (d.args ?? []) as readonly unknown[]) ?? `The transaction would fail on-chain (${d.errorName}).`;
    } catch {
      return `The transaction would fail on-chain (error ${data.slice(0, 10)}).`;
    }
  }
}

type ErrNode = { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };

function someInChain(e: unknown, test: (n: ErrNode) => boolean): boolean {
  let n: unknown = e;
  for (let depth = 0; depth < 8 && n != null && typeof n === "object"; depth++) {
    if (test(n as ErrNode)) return true;
    n = (n as ErrNode).cause;
  }
  return false;
}

const msgOf = (n: ErrNode) => `${typeof n.shortMessage === "string" ? n.shortMessage : ""} ${typeof n.message === "string" ? n.message : ""}`;

export const DECLINED_TEXT = "The wallet declined the request. Nothing was sent.";
export const REQUEST_OPEN_TEXT = "Your wallet already has a request open. Finish or close it first.";

export const isUserRejection = (e: unknown): boolean =>
  someInChain(e, (n) => n.code === 4001 || n.name === "UserRejectedRequestError" || /user rejected|user denied|rejected the request/i.test(msgOf(n)));

export const isRequestOpen = (e: unknown): boolean => someInChain(e, (n) => n.code === -32002 || /already pending/i.test(msgOf(n)));

/** One line on why something failed: decline, open prompt, decoded revert, else the first line. */
export function errText(e: unknown): string {
  if (isUserRejection(e)) return DECLINED_TEXT;
  if (isRequestOpen(e)) return REQUEST_OPEN_TEXT;
  const reason = revertReason(e);
  if (reason) return reason;
  const o = (e ?? {}) as { shortMessage?: unknown; message?: unknown };
  const s = typeof o.shortMessage === "string" ? o.shortMessage : typeof o.message === "string" ? o.message : String(e);
  return s.split("\n")[0] ?? s;
}
