// ViemChainGateway against an in-process EIP-1193 transport: eth_call calldata is decoded with the
// real ABIs and answered with ABI-encoded results, so function names, argument shapes and result
// decoding are exercised exactly as on a chain (incl. the no-Multicall3 fallback on 31337).
import { describe, expect, test } from "bun:test";
import { chainFor, strToBytes32 } from "@bookrunner/shared";
import {
  bkrnStakingAbi,
  bookAbi,
  bookrunnerConfigAbi,
  marketCharterAbi,
  mMMandateAbi,
  riskCommitteeAbi,
  stockTokenRegistryAbi,
  trancheAbi,
} from "@bookrunner/shared/abi";
import { type Abi, type Address, type Hex, createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi, zeroAddress, zeroHash } from "viem";
import { ViemChainGateway } from "../src/chain/viem";
import { MemoryKv } from "../src/kv";
import { A, fakeDeployment } from "./fakes";
import { ALICE, BOOK, sampleCharter } from "./fixtures";

type Handler = (args: readonly unknown[]) => unknown;
type Contract = { abi: Abi; fns: Record<string, Handler> };

function chainWith(contracts: Record<string, Contract>) {
  const calls: string[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method !== "eth_call") throw new Error(`unsupported ${method}`);
    const [{ to, data }] = params as [{ to: Address; data: Hex }];
    const c = contracts[to.toLowerCase()];
    if (!c) throw new Error(`no contract at ${to}`);
    const { functionName, args } = decodeFunctionData({ abi: c.abi, data });
    calls.push(`${to.toLowerCase()}.${functionName}`);
    const fn = c.fns[functionName];
    if (!fn) {
      const err = new Error("execution reverted") as Error & { code: number; data: Hex };
      err.code = 3;
      err.data = "0x";
      throw err;
    }
    return encodeFunctionResult({ abi: c.abi, functionName, result: fn(args ?? []) } as never);
  };
  const client = createPublicClient({ chain: chainFor(31337), transport: custom({ request }, { retryCount: 0 }), batch: { multicall: true } });
  return { client, calls };
}

const d = fakeDeployment();
const lc = (a: Address) => a.toLowerCase();
const c = sampleCharter();

function world() {
  const tranche: Contract = {
    abi: [...trancheAbi, ...erc20Abi] as Abi,
    fns: {
      balanceOf: () => 2_000_000n,
      totalSupply: () => 10_000_000n,
      committedOf: () => 7n,
      totalCommitted: () => 70n,
      depositsOpen: () => true,
      paused: () => false,
      claimableAllocation: () => [5n, 6n],
      // claimableAssets reverts (missing handler) -> defaults to 0
      convertToAssets: ([s]) => ((s as bigint) * 103n) / 100n,
      pendingRedeemRequest: ([id]) => ((id as bigint) === 9n ? 11n : 0n),
      claimableRedeemRequest: () => 0n,
    },
  };
  return chainWith({
    [lc(d.contracts.config)]: {
      abi: bookrunnerConfigAbi as Abi,
      fns: {
        charterFeeUsd: () => 5_000_000_000n,
        sponsorBondBkrn: () => 10n ** 23n,
        committeeBondBkrn: () => 25n * 10n ** 22n,
        markInterval: () => 300,
        maxPriceAge: () => 300,
        newBooksPaused: () => false,
        venueMinIfUsd: ([v]) => ((v as number) === 0 ? 25_000_000_000n : 10_000_000_000n),
        agentTierBond: () => 123n,
      },
    },
    [lc(d.contracts.charter)]: {
      abi: marketCharterAbi as Abi,
      fns: {
        validate: () => strToBytes32("BAD_SYMBOL"),
        count: () => 3n,
        get: () => ({ charter: c, status: 1, filedAt: 10n, decidedAt: 0n, juryCid: zeroHash, feePaidUsd: 5n, bondBkrn: 6n, book: zeroAddress }),
      },
    },
    [lc(d.contracts.stockRegistry)]: { abi: stockTokenRegistryAbi as Abi, fns: { isCanonical: () => true, isIndex: () => false } },
    [lc(d.contracts.committee)]: {
      abi: riskCommitteeAbi as Abi,
      fns: {
        members: () => [A(0xa8), A(0xa9), zeroAddress],
        juryVerdict: () => [`0x${"ab".repeat(32)}`, true, true],
        votesOf: () => [1, 0],
        isBonded: ([m]) => m !== A(0xa9),
        hasVoted: ([, m]) => m === A(0xa8),
      },
    },
    [lc(d.contracts.staking)]: { abi: bkrnStakingAbi as Abi, fns: { availableOf: () => 42n } },
    [lc(d.contracts.usdc)]: { abi: erc20Abi as Abi, fns: { balanceOf: () => 9n, allowance: () => 1n } },
    [lc(BOOK.book)]: {
      abi: bookAbi as Abi,
      fns: {
        state: () => 2,
        subscriptionEnds: () => 1_700_000_000n,
        sharePrice: ([k]) => ((k as number) === 0 ? 10n ** 18n : 11n * 10n ** 17n),
        trancheNav: () => [70n, 30n],
        lastMarkId: () => 4n,
      },
    },
    [lc(BOOK.senior)]: tranche,
    [lc(BOOK.mandate)]: {
      abi: mMMandateAbi as Abi,
      fns: { getMandate: () => c.mandate, killed: () => false, killReason: () => zeroHash, activeKeys: () => [A(0xde5c)] },
    },
  });
}

describe("ViemChainGateway (ABI round trip over EIP-1193)", () => {
  test("params, validate, registry, staking, usdc, tier bond", async () => {
    const { client } = world();
    const g = new ViemChainGateway(client as never, d, new MemoryKv(), 5);
    expect(await g.params()).toEqual({
      charterFeeUsd: 5_000_000_000n,
      sponsorBondBkrn: 10n ** 23n,
      committeeBondBkrn: 25n * 10n ** 22n,
      markInterval: 300,
      maxPriceAge: 300,
      newBooksPaused: false,
      venueMinIfUsd: [25_000_000_000n, 10_000_000_000n],
    });
    expect(await g.validateCharter(c)).toBe(strToBytes32("BAD_SYMBOL"));
    expect(await g.underlyingKnown(c.underlying)).toBe(true);
    expect(await g.stakeAvailable(ALICE)).toBe(42n);
    expect(await g.agentTierBond(1n)).toBe(123n);
    expect(await g.usdcState(ALICE, BOOK.senior)).toEqual({ balance: 9n, allowance: 1n });
    expect(await g.charterRecord(2)).toEqual({ status: 1, filedAt: 10, decidedAt: 0, juryCid: zeroHash, book: zeroAddress });
    expect(await g.charterRecord(4)).toBeNull();
  });

  test("committee state per seated member", async () => {
    const { client } = world();
    const g = new ViemChainGateway(client as never, d, new MemoryKv(), 5);
    const s = await g.committeeState(2);
    expect(s.members).toEqual([A(0xa8), A(0xa9)]);
    expect(s.juryVerdict).toEqual({ cid: `0x${"ab".repeat(32)}`, recommendApprove: true, posted: true });
    expect(s.approvals).toBe(1);
    expect(s.memberStatus).toEqual([
      { member: A(0xa8), bonded: true, voted: true },
      { member: A(0xa9), bonded: false, voted: false },
    ]);
  });

  test("book, tranche wallet (reverting views default), mandate; cached reads", async () => {
    const { client, calls } = world();
    const g = new ViemChainGateway(client as never, d, new MemoryKv(), 5);
    expect(await g.bookState(BOOK.book)).toEqual({
      state: 2,
      subscriptionEnds: 1_700_000_000,
      seniorPriceWad: 10n ** 18n,
      juniorPriceWad: 11n * 10n ** 17n,
      seniorNav: 70n,
      juniorNav: 30n,
      lastMarkId: 4,
    });
    const w = await g.trancheWallet(BOOK.senior, ALICE, [9n, 3n, 9n]);
    expect(w).toMatchObject({ shares: 2_000_000n, committed: 7n, depositsOpen: true, claimableShares: 5n, claimableRefund: 6n, claimableAssets: 0n, navValue: 2_060_000n });
    expect(w.buckets).toEqual([
      { requestId: 3n, pendingShares: 0n, claimableShares: 0n },
      { requestId: 9n, pendingShares: 11n, claimableShares: 0n },
    ]);
    const m = await g.mandateState(BOOK.mandate);
    expect(m.mandate).toEqual(c.mandate);
    expect(m.activeKeys).toEqual([A(0xde5c)]);
    const before = calls.length;
    await g.bookState(BOOK.book);
    await g.trancheWallet(BOOK.senior, ALICE, [3n, 9n]);
    expect(calls.length).toBe(before); // served from the TTL cache
  });

  test("a tranche whose views all revert is an error (not silent zeros)", async () => {
    const { client } = chainWith({ [lc(BOOK.junior)]: { abi: trancheAbi as Abi, fns: {} } });
    const g = new ViemChainGateway(client as never, d, new MemoryKv(), 0);
    await expect(g.trancheWallet(BOOK.junior, ALICE, [])).rejects.toThrow("view calls failed");
  });
});
