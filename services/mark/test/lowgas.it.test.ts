// On-chain integration of the low-gas mark path (docs/LOW_GAS.md §1-§3) against the real MarkRegistry,
// AttestedOracle, BookrunnerConfig and OrderlyAdapter bytecode, with the commitAndApply test doubles for the
// book and the venue adapter (contracts/test/core/MarkRegistryCommitAndApply.t.sol), on a PRIVATE anvil.
//   BKRN_IT=1 BKRN_CONTRACTS_OUT=<forge out dir> [BKRN_IT_ANVIL_PORT=8611] bun test test/lowgas.it.test.ts
// (uses BKRN_IT_ANVIL_PORT + 1)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Deployment, type PriceUpdate, VENUE, WAD, chainFor, createLogger, devAccount, priceTypedData, roleAccount, strToBytes32, usd, walletClientFor } from "@bookrunner/shared";
import { attestedOracleAbi, markRegistryAbi } from "@bookrunner/shared/abi";
import { type BookRef, TxSender } from "@bookrunner/waterfall";
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbiParameters, stringToHex, zeroAddress, zeroHash } from "viem";
import { encodeVenueReport, signVenueReport, venueReportDigest } from "../../ops-venue/src/report712";
import { readAfterPriceUpdate, unbatchedClient } from "../src/adapters/priceSim";
import { type SignedPrice, encodePriceData } from "../src/domain/prices";
import { LocalMarkSigner, MarkChainAdapter } from "../src/index";

const OUT = process.env.BKRN_CONTRACTS_OUT ?? "";
const PORT = Number(process.env.BKRN_IT_ANVIL_PORT ?? 8611) + 1;
const RPC = `http://127.0.0.1:${PORT}`;
const ENABLED =
  process.env.BKRN_IT === "1" && OUT !== "" && existsSync(join(OUT, "MarkRegistry.sol/MarkRegistry.json")) && existsSync(join(OUT, "MarkRegistryCommitAndApply.t.sol/CAMockBook.json"));
const CA = "MarkRegistryCommitAndApply.t.sol";

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe.skipIf(!ENABLED)("on-chain: MarkRegistry.commitAndApply + pull-oracle reads", () => {
  const log = createLogger("lowgas-it", "silent");
  let anvil: ReturnType<typeof Bun.spawn> | null = null;
  const pc = createPublicClient({ chain: chainFor(31337, RPC), transport: http(RPC), pollingInterval: 50 }) as PublicClient;
  const deployer = devAccount("deployer");
  const dw = walletClientFor(31337, RPC, deployer);
  const markSigner = roleAccount("markSigner");
  const oracleSigner = devAccount("oracleSigner");
  const opsKey = devAccount("opsVenue");
  const c = {} as Record<"config" | "oracle" | "factory" | "markRegistry" | "book" | "adapter" | "orderlyImpl", Address>;
  let ref: BookRef;
  let deployment: Deployment;
  const NVDA = strToBytes32("NVDA");

  async function deploy(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const a = artifact(file, name);
    const hash = await dw.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  }
  async function call(address: Address, file: string, name: string, fn: string, args: unknown[] = []) {
    const { abi } = artifact(file, name);
    const hash = await dw.sendTransaction({ to: address, data: encodeFunctionData({ abi, functionName: fn, args }) });
    const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (r.status !== "success") throw new Error(`${name}.${fn} reverted`);
  }
  async function read<T>(address: Address, file: string, name: string, fn: string, args: unknown[] = []): Promise<T> {
    return (await pc.readContract({ address, abi: artifact(file, name).abi, functionName: fn, args })) as T;
  }
  async function price(publishedAt: bigint, priceWad = 201n * WAD, signer = oracleSigner): Promise<SignedPrice> {
    const u: PriceUpdate = { underlying: NVDA, priceWad, publishedAt, held: false, sourceCount: 3, sourcesHash: `0x${"11".repeat(32)}` as Hex };
    return { ...u, priceId: "NVDA", signature: await signer.signTypedData(priceTypedData(31337, c.oracle, u)) };
  }
  const markChain = (registry = c.markRegistry) =>
    new MarkChainAdapter(pc, new TxSender(pc, walletClientFor(31337, RPC, markSigner), log, { pollingIntervalMs: 50 }), { ...deployment, contracts: { ...deployment.contracts, markRegistry: registry } });

  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pc.getBlockNumber();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const CFG = ["BookrunnerConfig.sol", "BookrunnerConfig"] as const;
    c.config = await deploy(...CFG, [deployer.address]);
    c.oracle = await deploy("AttestedOracle.sol", "AttestedOracle", [c.config, oracleSigner.address, zeroHash]);
    c.factory = await deploy("CoreMocks.sol", "CoreMockFactory");
    c.markRegistry = await deploy("MarkRegistry.sol", "MarkRegistry", [c.config]);
    for (const [k, v] of [
      ["oracle", c.oracle],
      ["factory", c.factory],
      ["markRegistry", c.markRegistry],
    ] as const) {
      await call(c.config, ...CFG, "setAddress", [strToBytes32(k), v]);
    }
    await call(c.config, ...CFG, "setParam", [strToBytes32("markInterval"), 300n]);
    await call(c.config, ...CFG, "setParam", [strToBytes32("maxMarkAge"), 3600n]);
    await call(c.config, ...CFG, "grantRole", [keccak256(stringToHex("MARK_SIGNER")), markSigner.address]);
    c.book = await deploy(CA, "CAMockBook", [c.markRegistry, 1n]);
    c.adapter = await deploy(CA, "CAMockAdapter", [c.markRegistry]);
    c.orderlyImpl = await deploy("OrderlyAdapter.sol", "OrderlyAdapter", [keccak256(stringToHex("broker")), keccak256(stringToHex("USDC"))]);
    const components = { book: c.book, senior: zeroAddress, junior: zeroAddress, vault: zeroAddress, mandate: zeroAddress, router: zeroAddress, desk: zeroAddress, adapter: c.adapter };
    await call(c.factory, "CoreMocks.sol", "CoreMockFactory", "register", [1n, components]);
    ref = { bookId: 1, venue: VENUE.ORDERLY, components };
    deployment = { chainId: 31337, startBlock: 0, contracts: c as unknown as Deployment["contracts"], stockTokens: {}, books: [] };
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("feature detection by eth_call: the low-gas registry has commitAndApply, a contract without it does not", async () => {
    expect(await markChain().supportsCommitAndApply()).toBe(true);
    expect(await markChain(c.adapter).supportsCommitAndApply()).toBe(false); // no such function, no fallback
  });

  test("ONE tx: oracle.update(priceData) + adapter.reportSigned(venueReport) + commit + applyMark", async () => {
    const chain = markChain();
    const head = await pc.getBlock();
    const periodEnd = (head.timestamp / 300n) * 300n;
    const input = { bookId: 1n, periodEnd, navUsd: usd("101000"), deployedValueUsd: usd("100000"), flowNonce: 0n, inventoryRoot: `0x${"11".repeat(32)}` as Hex, pnlJsonHash: `0x${"22".repeat(32)}` as Hex, receiptsRoot: `0x${"33".repeat(32)}` as Hex };
    const sig = await new LocalMarkSigner(markSigner, 31337, c.markRegistry).sign(input);
    const p = await price(head.timestamp);
    const priceData = encodePriceData([p]);
    const values = { insuranceUsd: usd("25000"), marginUsd: usd("75000"), netExposureUsd: -usd("1000"), asOf: head.timestamp };
    const reportSig = await signVenueReport(opsKey, 31337, c.adapter, values);
    const venueReport = encodeVenueReport({ ...values, signature: reportSig });

    // the binding encoding: abi.encode(uint256,int256,int256,uint64,bytes)
    expect(venueReport).toBe(encodeAbiParameters(parseAbiParameters("uint256, int256, int256, uint64, bytes"), [values.insuranceUsd, values.marginUsd, values.netExposureUsd, values.asOf, reportSig]));
    expect(await chain.simulateCommitAndApply(ref, input, sig, priceData, venueReport)).toEqual({ ok: true });

    // a print from an unknown signer reverts the whole tx (decoded), it is not "unsupported"
    const forged = await chain.simulateCommitAndApply(ref, input, sig, encodePriceData([await price(head.timestamp + 1n, 1n, devAccount("trader0"))]), "0x");
    expect(forged).toMatchObject({ ok: false, unsupported: false });
    expect(forged.ok === false && forged.error).toBe("BadSigner");

    const sender = new TxSender(pc, walletClientFor(31337, RPC, markSigner), log, { pollingIntervalMs: 50 });
    const out = await sender.send({ address: c.markRegistry, abi: markRegistryAbi, functionName: "commitAndApply", args: [input, sig, priceData, venueReport], label: "commitAndApply" });
    expect(out.receipt.status).toBe("success");
    const stored = await pc.readContract({ address: c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [NVDA] });
    expect(stored.priceWad).toBe(201n * WAD);
    expect(BigInt(stored.publishedAt)).toBe(head.timestamp);
    expect(await read<Hex>(c.adapter, CA, "CAMockAdapter", "lastArgsHash")).toBe(keccak256(`0x${venueReport.slice(2)}`));
    expect(await read<bigint>(c.book, CA, "CAMockBook", "lastMarkId")).toBe(1n);
    const mark = await pc.readContract({ address: c.markRegistry, abi: markRegistryAbi, functionName: "getMark", args: [1n] });
    expect(mark.applied).toBe(true);
    // the period is taken now: the next attempt is refused
    const again = await chain.simulateCommitAndApply(ref, input, sig, "0x", "0x");
    expect(again.ok).toBe(false);
    // the keeper's fallback when the venue step reverts: the same signed mark without the report
    await call(c.adapter, CA, "CAMockAdapter", "setRevertReport", [true]);
    const next = { ...input, periodEnd: periodEnd + 300n };
    await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [300] }) });
    await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }) });
    const sig2 = await new LocalMarkSigner(markSigner, 31337, c.markRegistry).sign(next);
    const vr2 = encodeVenueReport({ ...values, asOf: values.asOf + 300n, signature: await signVenueReport(opsKey, 31337, c.adapter, { ...values, asOf: values.asOf + 300n }) });
    expect(await chain.simulateCommitAndApply(ref, next, sig2, "0x", vr2)).toMatchObject({ ok: false, unsupported: false });
    expect(await chain.simulateCommitAndApply(ref, next, sig2, "0x", "0x")).toEqual({ ok: true });
  });

  test("engine-style reads see a signed print through one eth_call (update first), incl. a print dated after the block", async () => {
    const raw = unbatchedClient(pc);
    const head = await pc.getBlock();
    const views = [{ address: c.oracle, abi: attestedOracleAbi as Abi, functionName: "latest", args: [NVDA] }];
    const fresh = await price(head.timestamp + 2n, 333n * WAD);
    const r1 = await readAfterPriceUpdate(raw, { oracle: c.oracle, priceData: encodePriceData([fresh]), views, blockNumber: head.number });
    expect((r1?.[0] as { priceWad: bigint }).priceWad).toBe(333n * WAD);
    // nothing was sent
    expect((await pc.readContract({ address: c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [NVDA] })).priceWad).toBe(201n * WAD);
    // a print 60 s after the block: FuturePrice without the override, read with it
    const ahead = await price(head.timestamp + 60n, 444n * WAD);
    expect(await readAfterPriceUpdate(raw, { oracle: c.oracle, priceData: encodePriceData([ahead]), views, blockNumber: head.number })).toBeNull();
    const r2 = await readAfterPriceUpdate(raw, { oracle: c.oracle, priceData: encodePriceData([ahead]), views, blockNumber: head.number, time: ahead.publishedAt });
    expect((r2?.[0] as { priceWad: bigint }).priceWad).toBe(444n * WAD);
    // a print not newer than the stored one is skipped (the caller sees the stored price)
    const old = await price(1n, 1n * WAD);
    const r3 = await readAfterPriceUpdate(raw, { oracle: c.oracle, priceData: encodePriceData([old]), views, blockNumber: head.number });
    expect((r3?.[0] as { priceWad: bigint }).priceWad).toBe(201n * WAD);
  });

  test("venue report typed data == OrderlyAdapter.hashReport (domain verifyingContract = the adapter)", async () => {
    const values = { insuranceUsd: usd("25000"), marginUsd: -usd("12.5"), netExposureUsd: usd("4000"), asOf: 1_790_000_000n };
    const onchain = await read<Hex>(c.orderlyImpl, "OrderlyAdapter.sol", "OrderlyAdapter", "hashReport", [values.insuranceUsd, values.marginUsd, values.netExposureUsd, values.asOf]);
    expect(onchain).toBe(venueReportDigest(31337, c.orderlyImpl, values));
    expect(onchain).not.toBe(venueReportDigest(31337, c.adapter, values));
  });
});
