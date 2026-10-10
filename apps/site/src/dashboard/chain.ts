// Direct chain reads through the public RPC (viem). Protocol-wide addresses are resolved from the
// API's book list: Book.config() -> BookrunnerConfig getters (the apps/web useAppContracts path).
// A failed read becomes null for that one figure, so one bad call never blanks a view.
import { backstopAbi } from "@bookrunner/shared/abi/Backstop";
import { bkrnFeeRouterAbi } from "@bookrunner/shared/abi/BkrnFeeRouter";
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { bookAbi } from "@bookrunner/shared/abi/Book";
import { type Address, type Hex, createPublicClient, defineChain, encodeFunctionData, erc20Abi, getAddress, http } from "viem";
import { CHAIN } from "./config";
import { type TopUpRound, parseTopUp } from "./model";
import { sanitizeTokenSymbol } from "./token";
import { MOCK_MINT_ABI, TEST_USDC_AMOUNT } from "./txs";

export const appChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: { name: "Ether", symbol: CHAIN.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: `${CHAIN.name} explorer`, url: CHAIN.explorerUrl } },
  testnet: CHAIN.testnet,
});

export const publicClient = createPublicClient({ chain: appChain, transport: http(CHAIN.rpcUrl, { retryCount: 1, timeout: 15_000 }) });

const addressGetter = <N extends string>(name: N) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }) as const;

const CONFIG_ADDRESSES_ABI = [
  addressGetter("usdc"),
  addressGetter("bkrn"),
  addressGetter("staking"),
  addressGetter("feeRouter"),
  addressGetter("backstop"),
  addressGetter("markRegistry"),
  addressGetter("oracle"),
  addressGetter("charter"),
  addressGetter("committee"),
  addressGetter("factory"),
] as const;

const PROTOCOL_KEYS = ["usdc", "bkrn", "staking", "feeRouter", "backstop", "markRegistry", "oracle", "charter", "committee", "factory"] as const;
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];
export type ProtocolContracts = Record<ProtocolKey | "config", Address>;

const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Protocol addresses through any book (they are shared by every book of a deployment). */
export async function readProtocol(book: Address): Promise<ProtocolContracts> {
  const cfg = await publicClient.readContract({ address: book, abi: bookAbi, functionName: "config" });
  const values = await Promise.all(PROTOCOL_KEYS.map((k) => publicClient.readContract({ address: cfg, abi: CONFIG_ADDRESSES_ABI, functionName: k })));
  const out = { config: getAddress(cfg) } as ProtocolContracts;
  PROTOCOL_KEYS.forEach((k, i) => {
    const v = values[i];
    if (!v) throw new Error(`BookrunnerConfig.${k}() returned nothing`);
    out[k] = getAddress(v);
  });
  return out;
}

export interface BookParts {
  senior: Address;
  junior: Address;
  mandate: Address;
}

/** A book's tranches and mandate as the BOOK reports them on chain (not as the API lists them). */
export async function readBookParts(book: Address): Promise<BookParts> {
  const c = (await publicClient.readContract({ address: book, abi: bookAbi, functionName: "components" })) as { senior: Address; junior: Address; mandate: Address };
  return { senior: getAddress(c.senior), junior: getAddress(c.junior), mandate: getAddress(c.mandate) };
}

export async function readTopUp(book: Address): Promise<TopUpRound | null> {
  const raw = await soft(publicClient.readContract({ address: book, abi: bookAbi, functionName: "topUp" }));
  return raw ? parseTopUp(raw as readonly [boolean, bigint, bigint, bigint]) : null;
}

export async function readMaxTopUpWindow(book: Address): Promise<number | null> {
  const v = await soft(publicClient.readContract({ address: book, abi: bookAbi, functionName: "MAX_TOPUP_WINDOW" }));
  return v === null ? null : Number(v);
}

export interface Balances {
  eth: bigint | null;
  usdc: bigint | null;
  bkrn: bigint | null;
}

export async function readBalances(me: Address, usdc: Address | null, bkrn: Address | null): Promise<Balances> {
  const bal = (t: Address | null) => (t ? soft(publicClient.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [me] })) : Promise.resolve(null));
  const [eth, u, b] = await Promise.all([soft(publicClient.getBalance({ address: me })), bal(usdc), bal(bkrn)]);
  return { eth, usdc: u, bkrn: b };
}

/** ERC-20 symbol() of the settlement token (BookrunnerConfig.usdc()), sanitized for display. */
export async function readTokenSymbol(token: Address): Promise<string> {
  return sanitizeTokenSymbol(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }));
}

/** eth_call of MockERC20.mint(self, 10,000e6): true only where the token's mint is open (test networks). */
export async function canMintTestUsdc(usdc: Address, me: Address): Promise<boolean> {
  return publicClient
    .call({ account: me, to: usdc, data: encodeFunctionData({ abi: MOCK_MINT_ABI, functionName: "mint", args: [me, TEST_USDC_AMOUNT] }) })
    .then(() => true)
    .catch(() => false);
}

export interface StakingProtocol {
  totalStaked: bigint | null;
  cooldownSec: number | null;
  carryReceivedUsd: bigint | null;
  toBackstopUsd: bigint | null;
  buybackSpentUsd: bigint | null;
  buybackPendingUsd: bigint | null;
  distributedBkrn: bigint | null;
  backstopBalanceUsd: bigint | null;
  backstopCoveredUsd: bigint | null;
}

export async function readStakingProtocol(c: Pick<ProtocolContracts, "staking" | "feeRouter" | "backstop">): Promise<StakingProtocol> {
  const st = { address: c.staking, abi: bkrnStakingAbi } as const;
  const fr = { address: c.feeRouter, abi: bkrnFeeRouterAbi } as const;
  const bs = { address: c.backstop, abi: backstopAbi } as const;
  const [totalStaked, cooldown, carry, toBackstop, spent, pending, distributed, balance, covered] = await Promise.all([
    soft(publicClient.readContract({ ...st, functionName: "totalStaked" })),
    soft(publicClient.readContract({ ...st, functionName: "cooldown" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalCarryReceived" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalToBackstop" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalBuybackUsdc" })),
    soft(publicClient.readContract({ ...fr, functionName: "buybackPending" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalBkrnDistributed" })),
    soft(publicClient.readContract({ ...bs, functionName: "balance" })),
    soft(publicClient.readContract({ ...bs, functionName: "totalCovered" })),
  ]);
  return {
    totalStaked,
    cooldownSec: cooldown === null ? null : Number(cooldown),
    carryReceivedUsd: carry,
    toBackstopUsd: toBackstop,
    buybackSpentUsd: spent,
    buybackPendingUsd: pending,
    distributedBkrn: distributed,
    backstopBalanceUsd: balance,
    backstopCoveredUsd: covered,
  };
}

export interface StakePosition {
  staked: bigint;
  locked: bigint;
  available: bigint;
  pending: bigint;
  availableAt: number;
  earned: bigint;
  allowance: bigint;
}

/** One wallet's position. All reads must succeed: a partial position would offer wrong actions. */
export async function readStakePosition(staking: Address, bkrn: Address, me: Address): Promise<StakePosition> {
  const st = { address: staking, abi: bkrnStakingAbi } as const;
  const [staked, locked, available, pending, earned, allowance] = await Promise.all([
    publicClient.readContract({ ...st, functionName: "stakedOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "lockedOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "availableOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "pendingUnstakeOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "earned", args: [me] }),
    publicClient.readContract({ address: bkrn, abi: erc20Abi, functionName: "allowance", args: [me, staking] }),
  ]);
  const [pendingAmount, availableAt] = pending as readonly [bigint, bigint | number];
  return { staked, locked, available, pending: pendingAmount, availableAt: Number(availableAt), earned, allowance };
}

export async function waitForReceipt(hash: Hex) {
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 });
  return { status: r.status, blockNumber: r.blockNumber };
}
