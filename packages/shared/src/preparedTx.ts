// Client-side verification of prepared transactions (the API's {to, data, value, chainId, description}
// steps, and the ones the apps encode themselves) BEFORE any wallet prompt. The API is not trusted with
// what the wallet signs: a compromised API could describe "Approve 100 USDC for the Senior tranche" while
// the calldata says approve(attacker, max). Every step is decoded against the protocol ABIs and checked:
//   - chain, value 0, a known protocol function (no transfer / transferFrom / permit / setApprovalForAll ...)
//   - destination among the contracts this flow may call (chain-derived set, when the caller passes one)
//   - ERC-20 approve: the spender is the destination of a LATER step of the same flow (the contract that
//     pulls the funds), never unlimited, and exactly the amount that step moves (deposit / stake)
//   - amounts equal the amount the user entered; receivers / owners are the user's account
// The decoded summary (verifyPreparedTxs -> DecodedStep.summary) is what the review UI shows.
import { type Abi, type AbiFunction, type Hex, decodeFunctionData, erc20Abi, getAddress, isAddress, maxUint256 } from "viem";
import { bkrnStakingAbi } from "./abi/BkrnStaking";
import { bookAbi } from "./abi/Book";
import { marketCharterAbi } from "./abi/MarketCharter";
import { mMMandateAbi } from "./abi/MMMandate";
import { riskCommitteeAbi } from "./abi/RiskCommittee";
import { trancheAbi } from "./abi/Tranche";

export interface PreparedTxInput {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description?: string;
}

export interface PreparedCheck {
  chainId: number;
  /** Contracts this flow may call (derived from the chain, not from the API). Omitted: not checked. */
  targets?: readonly string[];
  /** The account the flow acts for: deposit receivers, redemption receivers / owners, claim users. */
  account?: string;
  /** The amount the user entered (raw units): deposit / stake amounts (and their approvals) must equal it. */
  amount?: bigint;
  /** Display names of known addresses ("USDC", "Senior tranche of book #1", ...). */
  labels?: Readonly<Record<string, string>>;
  /** Token decimals by address, for readable approve amounts. */
  decimals?: Readonly<Record<string, number>>;
}

export interface DecodedStep {
  to: `0x${string}`;
  functionName: string;
  args: readonly unknown[];
  /** Human-readable decoded call, e.g. "USDC.approve(spender Senior tranche of book #1, 100 USDC)". */
  summary: string;
}

export class PreparedTxError extends Error {
  constructor(message: string) {
    super(`${message} Nothing was sent.`);
    this.name = "PreparedTxError";
  }
}

const MOCK_MINT_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

/** Function names a prepared step may call, per ABI (anything else is refused). */
const ALLOWED: Array<[Abi, readonly string[]]> = [
  [erc20Abi as Abi, ["approve"]],
  [trancheAbi as Abi, ["deposit", "requestRedeem", "claimAllocation", "claimRedemption", "claimCancelledRefund"]],
  [bkrnStakingAbi as Abi, ["stake", "requestUnstake", "cancelUnstake", "unstake", "claimReward"]],
  [marketCharterAbi as Abi, ["file"]],
  [riskCommitteeAbi as Abi, ["vote"]],
  [mMMandateAbi as Abi, ["registerKey", "consentKey", "revokeKey"]],
  [bookAbi as Abi, ["openTopUp"]],
  [MOCK_MINT_ABI as Abi, ["mint"]],
];

const KNOWN_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: AbiFunction[] = [];
  for (const [abi, names] of ALLOWED) {
    for (const item of abi) {
      if (item.type !== "function" || !names.includes(item.name) || seen.has(item.name)) continue;
      seen.add(item.name);
      out.push(item);
    }
  }
  return out;
})();

/** The amount a step moves out of the signer's wallet through an approval (null: none). */
const pulledAmount = (fn: string, args: readonly unknown[]): bigint | null => (fn === "deposit" || fn === "stake" ? (args[0] as bigint) : null);

const lower = (a: string) => a.toLowerCase();

function fmtAmount(raw: bigint, decimals: number | undefined): string {
  if (decimals === undefined) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Decodes and checks every step; throws PreparedTxError on the first one that does not hold up. */
export function verifyPreparedTxs(txs: readonly PreparedTxInput[], check: PreparedCheck): DecodedStep[] {
  const labels = new Map(Object.entries(check.labels ?? {}).map(([a, l]) => [lower(a), l]));
  const decimals = new Map(Object.entries(check.decimals ?? {}).map(([a, d]) => [lower(a), d]));
  const targets = check.targets ? new Set(check.targets.map(lower)) : null;
  const account = check.account ? lower(check.account) : null;
  const name = (a: string) => labels.get(lower(a)) ?? getAddress(a);
  const tokenName = (a: string) => labels.get(lower(a)) ?? "tokens";

  const decoded = txs.map((t, i) => {
    const n = i + 1;
    if (t.chainId !== check.chainId) throw new PreparedTxError(`Step ${n} is for chain ${t.chainId}, not ${check.chainId}.`);
    if (!isAddress(t.to, { strict: false })) throw new PreparedTxError(`Step ${n} has an invalid destination address.`);
    if (!/^0x([0-9a-fA-F]{2})*$/.test(t.data) || t.data.length < 10) throw new PreparedTxError(`Step ${n} has malformed calldata.`);
    if (t.value !== "0") throw new PreparedTxError(`Step ${n} asks to send ETH; prepared steps never send value.`);
    if (targets && !targets.has(lower(t.to))) throw new PreparedTxError(`Step ${n} calls ${getAddress(t.to)}, which is not a contract of this flow.`);
    let call: { functionName: string; args?: readonly unknown[] };
    try {
      call = decodeFunctionData({ abi: KNOWN_ABI, data: t.data as Hex }) as { functionName: string; args?: readonly unknown[] };
    } catch {
      throw new PreparedTxError(`Step ${n} calls a function this app does not recognise (selector ${t.data.slice(0, 10)}).`);
    }
    return { n, to: getAddress(t.to), functionName: call.functionName, args: call.args ?? [] };
  });

  return decoded.map((s, i) => {
    const { n, to, functionName: fn, args } = s;
    const mustBeAccount = (v: unknown, what: string) => {
      if (account && (typeof v !== "string" || lower(v) !== account)) throw new PreparedTxError(`Step ${n} sends the ${what} to ${String(v)}, not your account ${getAddress(account)}.`);
    };
    let summary: string;
    switch (fn) {
      case "approve": {
        const [spender, amount] = args as [string, bigint];
        const later = decoded.slice(i + 1).find((x) => lower(x.to) === lower(spender));
        if (!later) throw new PreparedTxError(`Step ${n} approves ${getAddress(spender)}, which no later step of this flow uses.`);
        if (amount === maxUint256) throw new PreparedTxError(`Step ${n} asks for an unlimited approval.`);
        const pulled = pulledAmount(later.functionName, later.args);
        if (pulled !== null && amount !== pulled) throw new PreparedTxError(`Step ${n} approves ${amount} but step ${later.n} moves ${pulled}.`);
        if (pulled !== null && check.amount !== undefined && amount !== check.amount) throw new PreparedTxError(`Step ${n} approves ${amount}, not the ${check.amount} you entered.`);
        summary = `${tokenName(to)}.approve: let ${name(spender)} move ${fmtAmount(amount, decimals.get(lower(to)))} ${tokenName(to)} from your wallet (used by step ${later.n})`;
        break;
      }
      case "deposit": {
        const [assets, receiver] = args as [bigint, string];
        if (check.amount !== undefined && assets !== check.amount) throw new PreparedTxError(`Step ${n} deposits ${assets}, not the ${check.amount} you entered.`);
        mustBeAccount(receiver, "shares");
        summary = `${name(to)}.deposit(${fmtAmount(assets, decimals.get(lower(to)))}, receiver ${name(receiver)})`;
        break;
      }
      case "stake": {
        const [amount] = args as [bigint];
        if (check.amount !== undefined && amount !== check.amount) throw new PreparedTxError(`Step ${n} stakes ${amount}, not the ${check.amount} you entered.`);
        summary = `${name(to)}.stake(${fmtAmount(amount, decimals.get(lower(to)))})`;
        break;
      }
      case "requestRedeem": {
        const [shares, receiver, owner] = args as [bigint, string, string];
        if (check.amount !== undefined && shares !== check.amount) throw new PreparedTxError(`Step ${n} redeems ${shares} shares, not the ${check.amount} you entered.`);
        mustBeAccount(receiver, "redemption");
        mustBeAccount(owner, "redemption request (owner)");
        summary = `${name(to)}.requestRedeem(${fmtAmount(shares, decimals.get(lower(to)))} shares, receiver ${name(receiver)})`;
        break;
      }
      case "claimAllocation":
      case "claimCancelledRefund": {
        mustBeAccount(args[0], "claim");
        summary = `${name(to)}.${fn}(${name(args[0] as string)})`;
        break;
      }
      case "claimRedemption": {
        const [receiver, owner] = args as [string, string];
        mustBeAccount(receiver, "redeemed USDC");
        mustBeAccount(owner, "redemption claim (owner)");
        summary = `${name(to)}.claimRedemption(receiver ${name(receiver)})`;
        break;
      }
      case "mint": {
        const [who, amount] = args as [string, bigint];
        mustBeAccount(who, "minted tokens");
        summary = `${tokenName(to)}.mint(${name(who)}, ${fmtAmount(amount, decimals.get(lower(to)))})`;
        break;
      }
      default:
        summary = `${name(to)}.${fn}(${args.map((a) => (typeof a === "string" && isAddress(a, { strict: false }) ? name(a) : typeof a === "object" ? "{…}" : String(a))).join(", ")})`;
    }
    return { to, functionName: fn, args, summary };
  });
}
