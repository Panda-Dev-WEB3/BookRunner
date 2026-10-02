// Pull mode end to end against the PRODUCTION AttestedOracle + BookrunnerConfig (BKRN_IT=1; artifacts
// from contracts/out, i.e. `bash scripts/forge.sh build` first) on a PRIVATE anvil (ORACLE_IT_ANVIL_PORT,
// default 8622; never the shared devnet): the service signs and publishes the bundle without sending a
// single transaction; any account relays bundle.priceData through AttestedOracle.update and the stored
// prices are exactly the bundle's; a legacy contract (no update(bytes)) keeps the heartbeat pushes.
//   BKRN_IT=1 bun test test/pull.chain.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SESSIONS_24X7, decodePriceData, devAccount, encodeSessions, priceId, publicClientFor, walletClientFor } from "@bookrunner/shared";
import { attestedOracleAbi } from "@bookrunner/shared/abi";
import type { Subprocess } from "bun";
import { type Abi, type Address, type Hex, type PublicClient, toHex } from "viem";
import { ViemOracleChain } from "../src/adapters/chain";
import { buildUniverse } from "../src/domain/universe";
import { ScriptedSource, makeService, silentLog } from "./fakes";

const IT = process.env.BKRN_IT === "1";
const PORT = Number(process.env.ORACLE_IT_ANVIL_PORT ?? 8622);
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = resolve(import.meta.dir, "../../../contracts/out");

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(OUT, file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`${p} missing: run \`bash scripts/forge.sh build\` before BKRN_IT=1`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

function universe() {
  return buildUniverse({
    equities: [
      { priceId: "NVDA", underlying: priceId("NVDA") },
      { priceId: "TSLA", underlying: priceId("TSLA") },
    ],
    indexes: [
      {
        priceId: "RHX2",
        underlying: priceId("RHX2"),
        components: [
          { priceId: "NVDA", weightBps: 5000 },
          { priceId: "TSLA", weightBps: 5000 },
        ],
      },
    ],
    books: [],
    defaultSessions: encodeSessions(SESSIONS_24X7),
  }).entries;
}

describe.skipIf(!IT)("oracle pull mode on the production AttestedOracle (private anvil)", () => {
  let anvil: Subprocess | null = null;
  let pub: PublicClient;
  const deployer = devAccount("deployer");
  const signer = devAccount("oracleSigner");
  const relayer = devAccount("trader3");
  let config: Address;
  let oracle: Address;

  beforeAll(async () => {
    anvil = Bun.spawn([process.env.ANVIL_BIN ?? "anvil", "--port", String(PORT), "--accounts", "24", "--silent"], { stdout: "ignore", stderr: "ignore" });
    pub = publicClientFor(31337, RPC);
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const w = walletClientFor(31337, RPC, deployer);
    const deploy = async (a: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
      const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      if (!r.contractAddress) throw new Error("deploy failed");
      return r.contractAddress;
    };
    config = await deploy(artifact("BookrunnerConfig.sol", "BookrunnerConfig"), [deployer.address]);
    oracle = await deploy(artifact("AttestedOracle.sol", "AttestedOracle"), [config, signer.address, `0x${"00".repeat(32)}`]);
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  const nonce = () => pub.getTransactionCount({ address: signer.address });

  async function harness(oracleAddr: Address, pushMode: "pull" | "heartbeat" = "pull") {
    const sources = ["synthetic-a", "synthetic-b", "synthetic-c"].map((n) => new ScriptedSource(n));
    const parts = makeService({ sources, now: Date.now, settings: { pushMode } });
    const chain = new ViemOracleChain(pub, walletClientFor(31337, RPC, signer), oracleAddr, 31337, silentLog, 15_000);
    await parts.svc.setDeployment({ chainId: 31337, oracle: oracleAddr, chain });
    await parts.svc.setUniverse(universe());
    const set = (t: string, price: number) => sources.forEach((s) => s.set(t, { price }));
    set("NVDA", 190.25);
    set("TSLA", 441.5);
    return { ...parts, chain, set };
  }

  test("pull: no transaction from the oracle key; anyone relays the bundle and the chain stores it", async () => {
    const h = await harness(oracle);
    expect(h.svc.effectivePushMode()).toBe("pull");
    expect(h.svc.health().onchain.pullSupported).toBe(true);
    const n0 = await nonce();
    await h.svc.tick(Date.now());
    await h.svc.idle();
    const b = h.svc.signedBundle()!;
    expect(b.priceIds).toEqual(["NVDA", "TSLA", "RHX2"]);
    expect(await nonce()).toBe(n0); // pull mode never pushes

    const relay = async (priceData: Hex) => {
      const w = walletClientFor(31337, RPC, relayer);
      const { request } = await pub.simulateContract({ account: relayer, address: oracle, abi: attestedOracleAbi, functionName: "update", args: [priceData] });
      const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(request), pollingInterval: 100 });
      expect(r.status).toBe("success");
      return r.gasUsed;
    };
    await relay(b.priceData);
    const { updates } = decodePriceData(b.priceData);
    for (const u of updates) {
      expect(await pub.readContract({ address: oracle, abi: attestedOracleAbi, functionName: "latest", args: [u.underlying] })).toEqual({
        priceWad: u.priceWad,
        publishedAt: u.publishedAt,
        held: false,
        sourceCount: u.sourceCount,
      });
    }
    // priceOf (the strict consumer read) is fresh right after the relay
    const [px] = await pub.readContract({ address: oracle, abi: attestedOracleAbi, functionName: "priceOf", args: [priceId("NVDA")] });
    expect(px).toBe(190_250000000000000000n);

    // the next tick re-signs at the (later) chain head: the new bundle lands over the old one
    await pub.request({ method: "evm_increaseTime", params: [toHex(10)] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);
    h.set("NVDA", 191);
    await h.svc.tick(Date.now());
    const b2 = h.svc.signedBundle()!;
    expect(b2.publishedAt).toBeGreaterThan(b.publishedAt);
    const gasFresh = await relay(b2.priceData);
    const nv = await pub.readContract({ address: oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId("NVDA")] });
    expect(nv.priceWad).toBe(191n * 10n ** 18n);
    expect(Number(nv.publishedAt)).toBe(b2.publishedAt);
    // relaying the older bundle again is a no-op (not newer), not a revert — and cheap (no signature check)
    const gasReplay = await relay(b.priceData);
    expect((await pub.readContract({ address: oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId("NVDA")] })).priceWad).toBe(191n * 10n ** 18n);
    expect(await nonce()).toBe(n0);
    expect(gasReplay).toBeLessThan(gasFresh);
    console.log(`[gas] AttestedOracle.update standalone tx: 3 fresh prices ${gasFresh}, same bundle replayed (all skipped) ${gasReplay}`);
  }, 60_000);

  test("pull configured against a contract without update(bytes): detected, heartbeat pushes kept", async () => {
    // BookrunnerConfig stands in for a pre-low-gas oracle: same reads would fail, so only detection is asserted
    const legacy = new ViemOracleChain(pub, walletClientFor(31337, RPC, signer), config, 31337, silentLog);
    expect(await legacy.supportsUpdate()).toBe(false);
    const current = new ViemOracleChain(pub, walletClientFor(31337, RPC, signer), oracle, 31337, silentLog);
    expect(await current.supportsUpdate()).toBe(true);
  });

  test("heartbeat mode still pushes on the production contract (pushMany by the signer)", async () => {
    await pub.request({ method: "evm_increaseTime", params: [toHex(10)] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);
    const h = await harness(oracle, "heartbeat");
    const n0 = await nonce();
    await h.svc.tick(Date.now());
    await h.svc.idle();
    expect(await nonce()).toBe(n0 + 1);
    expect(h.svc.lastPush?.txHash).toBeTruthy();
    expect(h.svc.lastPush?.error).toBeUndefined();
    const r = await pub.getTransactionReceipt({ hash: h.svc.lastPush!.txHash! });
    console.log(`[gas] heartbeat pushMany (3 prices) by the oracle key: ${r.gasUsed} per push`);
  }, 60_000);
});
