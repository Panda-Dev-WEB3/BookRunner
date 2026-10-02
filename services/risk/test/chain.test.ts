// ViemChain against a fake EIP-1193 provider: ABI wiring of every read, Kill log scan, and the
// full write path (simulate -> sign with the RISK key -> send -> receipt).
import { describe, expect, test } from "bun:test";
import { type Deployment, VENUE, devAccount, localChain, priceId, strToBytes32, usd, wad } from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bookAbi,
  bookFactoryAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  mMMandateAbi,
  orderlyAdapterAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  zeroHash,
} from "viem";
import { ACTION_FLATTEN, ViemChain } from "../src/adapters/chain";
import { MANDATE, NVDA_TOKEN, T0, silentLog } from "./fakes";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const C = {
  config: A(0xc0),
  factory: A(0xfa),
  oracle: A(0x0c),
  stockRegistry: A(0x5e),
  book: A(0x101),
  senior: A(0x201),
  junior: A(0x301),
  vault: A(0x401),
  mandate: A(0x501),
  router: A(0x601),
  desk: A(0x701),
  adapter: A(0x801),
  usdc: A(0x900),
};

const ABIS: Record<string, Abi> = {
  [C.config]: bookrunnerConfigAbi,
  [C.factory]: bookFactoryAbi,
  [C.oracle]: attestedOracleAbi,
  [C.stockRegistry]: stockTokenRegistryAbi,
  [C.book]: bookAbi,
  [C.vault]: underwritingVaultAbi,
  [C.mandate]: mMMandateAbi,
  [C.desk]: bookrunnerDeskAbi,
  [C.adapter]: [...poolEngineAdapterAbi, ...orderlyAdapterAbi] as Abi,
  [NVDA_TOKEN]: erc20Abi,
  [C.usdc]: erc20Abi,
};

const components = { book: C.book, senior: C.senior, junior: C.junior, vault: C.vault, mandate: C.mandate, router: C.router, desk: C.desk, adapter: C.adapter };
const charter = {
  underlying: `0x${"0".repeat(24)}${NVDA_TOKEN.slice(2)}` as Hex,
  venue: VENUE.ORDERLY,
  oracle: 1,
  sessions: zeroHash,
  ifTargetUsd: usd(25_000),
  mmInventoryUsd: usd(75_000),
  mandate: MANDATE,
  seniorHurdleBps: 6000,
  seniorCapBps: 7000,
  subscriptionWindow: 600,
  juniorNoticeSeconds: 900n,
  sponsor: A(7),
  perWalletCapUsd: 0n,
  symbol: strToBytes32("PERP_NVDA_USDC"),
  takerFeeBps: 5,
  makerFeeBps: 0,
};

const RESULTS: Record<string, unknown> = {
  [`${C.factory}:bookIds`]: [1n, 2n],
  [`${C.factory}:componentsOf`]: components,
  [`${C.book}:getCharter`]: charter,
  [`${C.stockRegistry}:priceIdOf`]: priceId("NVDA"),
  [`${C.book}:state`]: 2,
  [`${C.mandate}:getMandate`]: MANDATE,
  [`${C.mandate}:killed`]: false,
  [`${C.mandate}:killReason`]: zeroHash,
  [`${C.adapter}:netExposureUsd`]: usd(-20_000),
  [`${C.adapter}:deployedValueUsd`]: usd(84_000),
  [`${C.adapter}:insuranceEquityUsd`]: usd(25_000),
  [`${C.adapter}:inTransitUsd`]: 0n,
  [`${C.adapter}:valuationAt`]: BigInt(T0),
  [`${C.adapter}:accountId`]: keccak256("0x01"),
  [`${C.desk}:hedgeNotionalUsd`]: usd(16_000),
  [`${C.desk}:valueUsd`]: usd(16_000),
  [`${C.desk}:heldTokens`]: [NVDA_TOKEN],
  [`${C.desk}:execute`]: "0x",
  [`${C.vault}:idle`]: 0n,
  [`${C.book}:unfundedClaims`]: 0n,
  [`${C.book}:perfIndex`]: [wad(1), wad(1)],
  [`${C.book}:trancheNav`]: [usd(70_000), usd(30_000)],
  [`${C.oracle}:latest`]: { priceWad: wad(190), publishedAt: BigInt(T0), held: false, sourceCount: 3 },
  [`${C.oracle}:isStale`]: false,
  [`${C.config}:maxPriceAge`]: 300,
  [`${NVDA_TOKEN}:balanceOf`]: 10n * 10n ** 18n,
  [`${C.stockRegistry}:getToken`]: { token: NVDA_TOKEN, priceId: priceId("NVDA"), multiplierWad: wad(1), decimals: 18, active: true, floatCapRaw: 0n },
  [`${C.stockRegistry}:valueUsdAt`]: usd(1_900),
  [`${C.mandate}:kill`]: undefined,
  [`${C.adapter}:setReduceOnly`]: undefined,
};

function fakeProvider(reverts: ReadonlySet<string> = new Set()) {
  const sent: Hex[] = [];
  const killLog = {
    topics: encodeEventTopics({ abi: mMMandateAbi, eventName: "Kill", args: { by: A(0x99) } }),
    data: encodeAbiParameters(parseAbiParameters("bytes32"), [strToBytes32("DRAWDOWN")]),
  };
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return "0x64";
      case "eth_call": {
        const { to, data } = p[0] as { to: Address; data: Hex };
        const abi = ABIS[to.toLowerCase()];
        if (!abi) throw new Error(`no contract at ${to}`);
        const { functionName } = decodeFunctionData({ abi, data });
        const key = `${to.toLowerCase()}:${functionName}`;
        if (reverts.has(key)) throw new Error(`execution reverted: ${key}`);
        if (key === `${C.usdc}:balanceOf`) return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: usd(500) });
        if (!(key in RESULTS)) throw new Error(`unexpected call ${key}`);
        const out = RESULTS[key];
        return out === undefined ? "0x" : encodeFunctionResult({ abi, functionName, result: out } as never);
      }
      case "eth_getLogs":
        return [
          {
            address: C.mandate,
            topics: killLog.topics,
            data: killLog.data,
            blockNumber: "0x50",
            transactionHash: keccak256("0x5150"),
            transactionIndex: "0x0",
            blockHash: keccak256("0xb10c"),
            logIndex: "0x0",
            removed: false,
          },
        ];
      case "eth_getTransactionCount":
        return `0x${sent.length.toString(16)}`;
      case "eth_estimateGas":
        return "0x30000";
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_getBlockByNumber":
        return { number: "0x64", baseFeePerGas: "0x1", hash: keccak256("0x64"), timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction":
        sent.push(p[0] as Hex);
        return keccak256(p[0] as Hex);
      case "eth_getTransactionReceipt": {
        const hash = p[0] as Hex;
        return {
          transactionHash: hash,
          blockHash: keccak256("0xb1"),
          blockNumber: "0x64",
          contractAddress: null,
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          from: devAccount("risk").address,
          gasUsed: "0x5208",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          to: C.mandate,
          transactionIndex: "0x0",
          type: "0x2",
        };
      }
      default:
        throw new Error(`unsupported rpc ${method}`);
    }
  };
  return { request, sent };
}

function makeChain(reverts?: ReadonlySet<string>) {
  const provider = fakeProvider(reverts);
  const transport = custom({ request: provider.request });
  const pub = createPublicClient({ chain: localChain, transport, pollingInterval: 5 });
  const wallet = createWalletClient({ chain: localChain, transport, account: devAccount("risk") });
  const dep = { chainId: 31337, startBlock: 0, contracts: C, stockTokens: {}, books: [] } as unknown as Deployment;
  return { chain: new ViemChain(pub as never, wallet, dep, { txTimeoutMs: 5_000, killLogLookbackBlocks: 0, log: silentLog }), sent: provider.sent };
}

describe("ViemChain reads", () => {
  test("discovery: book ids, components, charter, oracle key", async () => {
    const { chain } = makeChain();
    expect(await chain.listBookIds()).toEqual([1, 2]);
    const ref = await chain.loadRef(1);
    expect(ref).toMatchObject({ bookId: 1, venue: VENUE.ORDERLY, priceIdStr: "NVDA", symbol: "PERP_NVDA_USDC" });
    expect(ref.components.mandate.toLowerCase()).toBe(C.mandate);
    expect(await chain.bookState(ref)).toBe("Live");
    expect(await chain.orderlyAccountId(ref)).toBe(keccak256("0x01"));
  });

  test("observe() decodes every per-tick read", async () => {
    const { chain } = makeChain();
    const o = await chain.observe(await chain.loadRef(1));
    expect(o).toMatchObject({
      bookState: "Live",
      killed: false,
      vaultIdleUsd: 0n,
      seniorNavUsd: usd(70_000),
      juniorNavUsd: usd(30_000),
      perfIndexWad: wad(1),
      highWaterWad: wad(1),
      maxPriceAgeSec: 300,
      oracle: { priceWad: wad(190), publishedAt: T0, held: false, stale: false, source: "chain" },
    });
    expect(o.mandate).toEqual(MANDATE);
    expect(o.adapter).toEqual({ netExposureUsd: usd(-20_000), deployedValueUsd: usd(84_000), insuranceEquityUsd: usd(25_000), inTransitUsd: 0n, valuationAt: T0 });
    expect(o.desk).toEqual({ hedgeNotionalUsd: usd(16_000), valueUsd: usd(16_000), priceStale: false });
  });

  test("observe() survives a desk valuation that reverts StalePrice: values holdings at the last attested price", async () => {
    // BookrunnerDesk.valueUsd/hedgeNotionalUsd -> registry.valueUsd -> oracle.priceOf reverts StalePrice
    const { chain } = makeChain(new Set([`${C.desk}:hedgeNotionalUsd`, `${C.desk}:valueUsd`]));
    const o = await chain.observe(await chain.loadRef(1));
    // 10 NVDA via registry.valueUsdAt(token, qty, latest.priceWad) = 1,900; desk USDC 500
    expect(o.desk).toEqual({ hedgeNotionalUsd: usd(1_900), valueUsd: usd(2_400), priceStale: true });
    // every other limit input is still observed, so venue-exposure limits and kills keep running
    expect(o.adapter.netExposureUsd).toBe(usd(-20_000));
    expect(o.mandate).toEqual(MANDATE);
  });

  test("latest Kill log and desk holdings (registry valuation)", async () => {
    const { chain } = makeChain();
    const ref = await chain.loadRef(1);
    const k = await chain.latestKill(ref);
    expect(k?.txHash).toBe(keccak256("0x5150"));
    expect(k?.reason).toBe(strToBytes32("DRAWDOWN"));
    expect(k?.by.toLowerCase()).toBe(A(0x99));
    const h = await chain.deskHoldings(ref);
    expect(h.map((x) => ({ ...x, token: x.token.toLowerCase() }))).toEqual([
      { token: NVDA_TOKEN, qtyRaw: 10n * 10n ** 18n, valueUsd: usd(1_900), priceWad: wad(190), multiplierWad: wad(1), decimals: 18 },
    ]);
  });
});

describe("ViemChain writes (RISK role)", () => {
  test("mandate.kill: simulated, signed by roleAccount('risk'), sent, receipt awaited", async () => {
    const { chain, sent } = makeChain();
    const ref = await chain.loadRef(1);
    const hash = await chain.mandateKill(ref, "INVENTORY");
    expect(sent).toHaveLength(1);
    const raw = sent[0] as Hex;
    expect(hash).toBe(keccak256(raw));
    const tx = parseTransaction(raw as never);
    expect(tx.to?.toLowerCase()).toBe(C.mandate);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(devAccount("risk").address);
    const call = decodeFunctionData({ abi: mMMandateAbi, data: tx.data as Hex });
    expect(call.functionName).toBe("kill");
    expect(call.args?.[0]).toBe(strToBytes32("INVENTORY"));
    // buffered gas: eth_estimateGas 0x30000 (196,608) * 1.3 + 30k, never the raw estimate
    expect(tx.gas).toBe(285_590n);
  });

  test("desk Flatten action encoding and adapter reduce-only", async () => {
    const { chain, sent } = makeChain();
    const ref = await chain.loadRef(1);
    await chain.flatten(
      ref,
      { token: NVDA_TOKEN, amountIn: 5n * 10n ** 18n, expectedOutUsd: usd(950), minAmountOut: usd(940.5), priceWad: wad(190), multiplierWad: wad(1) },
      3000,
    );
    await chain.setReduceOnly(ref);
    expect(sent).toHaveLength(2);
    const flat = parseTransaction(sent[0] as never);
    const exec = decodeFunctionData({ abi: bookrunnerDeskAbi, data: flat.data as Hex });
    expect(exec.functionName).toBe("execute");
    const action = exec.args?.[0] as { kind: number; data: Hex; proof: readonly Hex[] };
    expect(action.kind).toBe(ACTION_FLATTEN);
    expect(action.proof).toEqual([]);
    const [token, amountIn, minOut, fee, venue] = decodeAbiParameters(
      parseAbiParameters("address token, uint256 amountIn, uint256 minAmountOut, uint24 poolFee, bytes32 venue"),
      action.data,
    );
    expect([token.toLowerCase(), amountIn, minOut, fee, venue]).toEqual([NVDA_TOKEN, 5n * 10n ** 18n, usd(940.5), 3000, strToBytes32("UNIV3")]);
    expect(flat.gas).toBe(285_590n);
    const ro = parseTransaction(sent[1] as never);
    expect(ro.gas).toBe(285_590n);
    expect(ro.to?.toLowerCase()).toBe(C.adapter);
    expect(decodeFunctionData({ abi: poolEngineAdapterAbi, data: ro.data as Hex })).toMatchObject({ functionName: "setReduceOnly", args: [true] });
  });
});
