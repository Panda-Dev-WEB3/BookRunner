// Signed venue reports (docs/LOW_GAS.md §2): typed data, encoding, parsing, the on-chain acceptance
// preview, and the Reporter in OPS_REPORT_MODE=signed (no report tx, hold rules unchanged).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNT, devAccount } from "@bookrunner/shared";
import { type Address, encodeAbiParameters, getAddress, type Hex, keccak256, parseAbiParameters, stringToHex, toFunctionSelector, zeroAddress } from "viem";
import { codeHasSelector, REPORT_SIGNED_SELECTOR, selectorPush } from "../src/chain";
import { loadOpsEnv } from "../src/config";
import {
  decodeVenueReport,
  encodeVenueReport,
  newestReport,
  parseSignedVenueReport,
  recoverVenueReportSigner,
  REPORT_TYPEHASH,
  reportConsistent,
  reportDeployedValueUsd,
  reportIncludable,
  type SignedVenueReport,
  signVenueReport,
  toSignedVenueReportJson,
  venueReportDigest,
  venueReportKey,
  venueReportRecentKey,
  venueReportSignatureValid,
  verifyVenueReport,
} from "../src/report712";
import { handleVenueOpsJob } from "../src/worker/jobs";
import { accountReportSigner, MemoryReportPublisher, RedisReportPublisher } from "../src/worker/reportSink";
import { ADAPTER, IF_ID, MM_ID, OPS, setupReporting, SYMBOL, testReportSigner } from "./helpers";

const R = { insuranceUsd: 25_000_000_000n, marginUsd: -1_500_000n, netExposureUsd: -1_900_000_000n, asOf: 1_800_000_000n };
const OTHER = "0x00000000000000000000000000000000000b0b01" as Address;

async function signed(over: Partial<SignedVenueReport> = {}): Promise<SignedVenueReport> {
  const base = { ...R, ...over };
  const adapter = over.adapter ?? ADAPTER;
  const chainId = over.chainId ?? 31337;
  const signature = over.signature ?? (await signVenueReport(OPS, chainId, adapter, base));
  return { bookId: 1, chainId, adapter, signer: OPS.address, signedAt: 1, ...base, signature };
}

describe("VenueReport typed data", () => {
  test("REPORT_TYPEHASH is the binding type string; signature recovers to the OPS key over the adapter domain", async () => {
    expect(REPORT_TYPEHASH).toBe(keccak256(stringToHex("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)")));
    const sig = await signVenueReport(OPS, 31337, ADAPTER, R);
    expect(await recoverVenueReportSigner(31337, ADAPTER, R, sig)).toBe(OPS.address);
    // the test helper signer (inline typed data) must produce the same signature
    expect(await testReportSigner(31337).sign(ADAPTER, R)).toBe(sig);
    expect(await accountReportSigner(OPS, 31337).sign(ADAPTER, R)).toBe(sig);
    // domain binding: another adapter / chain / value recovers to a different address
    expect(await recoverVenueReportSigner(31337, OTHER, R, sig)).not.toBe(OPS.address);
    expect(await recoverVenueReportSigner(46630, ADAPTER, R, sig)).not.toBe(OPS.address);
    expect(await recoverVenueReportSigner(31337, ADAPTER, { ...R, asOf: R.asOf + 1n }, sig)).not.toBe(OPS.address);
    expect(venueReportDigest(31337, ADAPTER, R)).not.toBe(venueReportDigest(31337, OTHER, R));
  });

  test("signature validity check: a wrong signer / tampered value is rejected", async () => {
    expect(await venueReportSignatureValid(await signed())).toBe(true);
    const mallory = devAccount("trader0");
    const forged = await signed({ signature: await signVenueReport(mallory, 31337, ADAPTER, R) }); // names OPS as signer
    expect(await venueReportSignatureValid(forged)).toBe(false);
    expect(await venueReportSignatureValid({ ...(await signed()), marginUsd: 5n })).toBe(false);
    expect(await venueReportSignatureValid({ ...(await signed()), signature: `0x${"00".repeat(65)}` })).toBe(false);
  });

  test("commitAndApply venueReport = abi.encode(uint256,int256,int256,uint64,bytes)", async () => {
    const s = await signed();
    const enc = encodeVenueReport(s);
    expect(enc).toBe(encodeAbiParameters(parseAbiParameters("uint256, int256, int256, uint64, bytes"), [R.insuranceUsd, R.marginUsd, R.netExposureUsd, R.asOf, s.signature]));
    expect(decodeVenueReport(enc)).toEqual({ ...R, signature: s.signature });
  });

  test("Redis keys", () => {
    expect(venueReportKey(3)).toBe("bkrn:venue:report:3");
    expect(venueReportRecentKey(3)).toBe("bkrn:venue:report:3:recent");
  });
});

describe("parseSignedVenueReport", () => {
  test("round trip through the published JSON (string or object)", async () => {
    const s = await signed();
    const json = toSignedVenueReportJson(s);
    expect(json.insuranceUsd).toBe("25000000000");
    expect(json.asOf).toBe(1_800_000_000);
    const expected = { ...s, adapter: getAddress(s.adapter) };
    expect(parseSignedVenueReport(json)).toEqual(expected);
    expect(parseSignedVenueReport(JSON.stringify(json))).toEqual(expected);
  });

  test("malformed / out-of-range reports are rejected", async () => {
    const json = toSignedVenueReportJson(await signed());
    expect(parseSignedVenueReport("{not json")).toBeNull();
    expect(parseSignedVenueReport(null)).toBeNull();
    expect(parseSignedVenueReport({ ...json, insuranceUsd: "1.5" })).toBeNull();
    expect(parseSignedVenueReport({ ...json, insuranceUsd: "-1" })).toBeNull();
    expect(parseSignedVenueReport({ ...json, marginUsd: (1n << 127n).toString() })).toBeNull(); // > int128 max
    expect(parseSignedVenueReport({ ...json, asOf: 0 })).toBeNull();
    expect(parseSignedVenueReport({ ...json, adapter: "0x1234" })).toBeNull();
    expect(parseSignedVenueReport({ ...json, signature: "0xdead" })).toBeNull();
    expect(parseSignedVenueReport({ ...json, signer: "0x1234" })).toBeNull();
  });

  test("published JSON is a superset of the shared VenueReportMsg (sig + ready-made venueReport)", async () => {
    const s = await signed();
    const json = toSignedVenueReportJson(s);
    expect(json.sig).toBe(s.signature);
    expect(json.venueReport).toBe(encodeVenueReport(s));
    expect(decodeVenueReport(json.venueReport)).toEqual({ insuranceUsd: s.insuranceUsd, marginUsd: s.marginUsd, netExposureUsd: s.netExposureUsd, asOf: s.asOf, signature: s.signature });
  });

  test("a bare VenueReportMsg (no signer, `sig` only): the signer is recovered and bound", async () => {
    const s = await signed();
    const { signer: _s, signature: _sig, ...bare } = toSignedVenueReportJson(s);
    const parsed = parseSignedVenueReport(bare);
    expect(parsed?.signer).toBe(zeroAddress);
    expect((await verifyVenueReport(parsed!))?.signer).toBe(OPS.address);
    // a declared signer that the signature does not recover to is refused
    expect(await verifyVenueReport({ ...parsed!, signer: devAccount("risk").address })).toBeNull();
    // tampered values recover to some other address: the caller's OPS_VENUE role check rejects it
    const tampered = await verifyVenueReport({ ...parsed!, insuranceUsd: parsed!.insuranceUsd + 1n });
    expect(tampered?.signer).not.toBe(OPS.address);
  });
});

describe("report acceptance preview (mirrors OrderlyAdapter.reportSigned / report rules)", () => {
  const ok = { valuationAt: R.asOf - 60n, lastFlowAt: R.asOf - 120n, pendingWithdrawUsd: 0n };

  test("includable: newer than the adapter, after the last flow, nothing pending, not in the future", () => {
    expect(reportIncludable(R, ok, R.asOf)).toBeNull();
    expect(reportIncludable(R, { ...ok, pendingWithdrawUsd: 1n }, R.asOf + 10n)).toMatch(/withdrawal pending/);
    expect(reportIncludable(R, { ...ok, valuationAt: R.asOf }, R.asOf + 10n)).toMatch(/not newer/); // replay of the stored report
    expect(reportIncludable(R, { ...ok, lastFlowAt: R.asOf + 1n }, R.asOf + 10n)).toMatch(/predates the last venue flow/);
    expect(reportIncludable(R, ok, R.asOf - 1n)).toMatch(/future/);
  });

  test("consistent for valuation: same adapter + chain, within [lastFlowAt, snapshot]", async () => {
    const s = await signed();
    const o = { adapter: ADAPTER, chainId: 31337, snapshotTs: R.asOf + 5n, state: { lastFlowAt: R.asOf - 1n } };
    expect(reportConsistent(s, o)).toBeNull();
    expect(reportConsistent(s, { ...o, adapter: OTHER })).toMatch(/another adapter/);
    expect(reportConsistent(s, { ...o, chainId: 1 })).toMatch(/chain 31337/);
    expect(reportConsistent(s, { ...o, snapshotTs: R.asOf - 1n })).toMatch(/after the snapshot/);
    expect(reportConsistent(s, { ...o, state: { lastFlowAt: R.asOf + 1n } })).toMatch(/predates/);
  });

  test("deployed value = insurance + max(margin, 0) + in-transit; newest passing candidate wins", () => {
    expect(reportDeployedValueUsd(R, 7n)).toBe(R.insuranceUsd + 7n);
    expect(reportDeployedValueUsd({ ...R, marginUsd: 10n }, 0n)).toBe(R.insuranceUsd + 10n);
    const cands = [{ asOf: 5n }, { asOf: 9n }, { asOf: 7n }];
    expect(newestReport(cands, () => true)?.asOf).toBe(9n);
    expect(newestReport(cands, (r) => r.asOf < 9n)?.asOf).toBe(7n);
    expect(newestReport(cands, () => false)).toBeNull();
  });
});

describe("Reporter, OPS_REPORT_MODE=signed", () => {
  test("signs + publishes, sends NO report tx; the signature verifies against the adapter domain", async () => {
    const t = await setupReporting("signed");
    const sig = await t.svc.reporter.report(t.book());
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(t.chain.count("report")).toBe(0);
    const pub = t.reports.latest.get(1);
    expect(pub).toBeDefined();
    const parsed = parseSignedVenueReport(pub)!;
    expect(parsed.adapter.toLowerCase()).toBe(ADAPTER.toLowerCase());
    expect(parsed.insuranceUsd).toBe(25_000_000_000n);
    expect(parsed.marginUsd).toBe(75_000_000_000n);
    expect(parsed.signer).toBe(OPS.address);
    expect(await recoverVenueReportSigner(31337, ADAPTER, parsed, parsed.signature)).toBe(OPS.address);
    // same second again: monotonic asOf, nothing new signed
    expect(await t.svc.reporter.report(t.book())).toBeNull();
    t.tick(15);
    await t.svc.reportAll();
    expect(t.reports.published).toHaveLength(2);
    expect(t.reports.published[1]!.asOf).toBe(Number(parsed.asOf) + 15);
    expect(t.chain.count("report")).toBe(0);
  });

  test("hold rules still apply to what gets signed: in-flight withdrawal and the settle window", async () => {
    const t = await setupReporting("signed");
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 30_000_000_000n);
    expect(await t.svc.reporter.report(t.book())).toBeNull(); // requested, unconfirmed on the adapter
    await t.svc.logs.poll();
    t.chain.failNext.confirmWithdraw = "rpc down";
    await t.svc.withdrawals.processAll(); // venue debited, confirm failed: saga in flight
    t.tick(60);
    expect(await t.svc.reporter.report(t.book())).toBeNull();
    await t.svc.withdrawals.processNonce(1, req.nonce.toString());
    t.tick(5);
    expect(await t.svc.reporter.report(t.book())).toBeNull(); // confirm = venue flow: settle window
    expect(t.reports.published).toHaveLength(0);
    t.tick(60);
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    const r = parseSignedVenueReport(t.reports.latest.get(1))!;
    expect(r.marginUsd).toBe(45_000_000_000n); // venue-debited value, after the flow
    expect(r.asOf >= t.chain.adapter(ADAPTER).lastFlowAt + 30n).toBe(true);
    expect(t.chain.count("report")).toBe(0);
  });

  test("deposit settle window holds the signed report too", async () => {
    const t = await setupReporting("signed");
    t.chain.adapter(ADAPTER).lastFlowAt = t.chain.headTs - 5n;
    expect(await t.svc.reporter.report(t.book())).toBeNull();
    t.tick(30);
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
  });

  test("sharp unexplained fall: held until it persists (signed mode)", async () => {
    const t = await setupReporting("signed");
    t.mock.venue.getAccount(MM_ID).holding = 0; // e.g. a simulator restart reading empty
    t.mock.venue.getAccount(IF_ID).holding = 0;
    for (let i = 0; i < 2; i++) {
      t.tick(15);
      expect(await t.svc.reporter.report(t.book())).toBeNull();
    }
    t.tick(15);
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    expect(t.reports.published).toHaveLength(1);
  });

  test("adapter implementation without reportSigned: the signed report is ALSO posted on-chain", async () => {
    const t = await setupReporting("signed");
    t.chain.reportSignedSupported = false;
    const r = await t.svc.reporter.reportDetailed(t.book());
    expect(r?.mode).toBe("signed");
    expect(r?.signature).toMatch(/^0x/);
    expect(r?.tx).toMatch(/^0x/);
    expect(t.chain.count("report")).toBe(1);
    expect(t.chain.calls.find((c) => c.fn === "report")?.args.slice(1, 5)).toEqual([25_000_000_000n, 75_000_000_000n, 0n, r!.asOf]);
    expect(t.reports.published).toHaveLength(1);
  });

  test("support check failing (RPC) never falls back to a tx", async () => {
    const t = await setupReporting("signed");
    t.chain.reportSignedSupported = "throw";
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    expect(t.chain.count("report")).toBe(0);
  });

  test("publish failure: nothing recorded, the next run signs again", async () => {
    const t = await setupReporting("signed");
    t.reports.fail = "redis down";
    await expect(t.svc.reporter.report(t.book())).rejects.toThrow("redis down");
    expect(t.sagas.get().lastAsOf[ADAPTER.toLowerCase()]).toBeUndefined();
    t.reports.fail = null;
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    expect(t.reports.published).toHaveLength(1);
  });

  test("report job follows the mode", async () => {
    const t = await setupReporting("signed");
    const deps = { ctx: t.ctx, registry: t.svc.registry, provisioner: t.svc.provisioner, reporter: t.svc.reporter, withdrawals: t.svc.withdrawals, fees: t.svc.fees, revoker: t.svc.revoker };
    const out = await handleVenueOpsJob({ kind: "report", bookId: 1 }, deps);
    expect(out.mode).toBe("signed");
    expect(out.tx).toBeNull();
    expect(String(out.signature)).toMatch(/^0x/);
    expect(t.chain.count("report")).toBe(0);
  });

  test("onchain mode is unchanged (report tx, nothing published)", async () => {
    const t = await setupReporting("onchain");
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    expect(t.chain.count("report")).toBe(1);
    expect(t.reports.published).toHaveLength(0);
  });
});

describe("RedisReportPublisher", () => {
  function fakeRedis(fail?: Error) {
    const ops: Array<[string, ...unknown[]]> = [];
    const m = {
      set: (k: string, v: string) => ops.push(["set", k, v]),
      lpush: (k: string, v: string) => ops.push(["lpush", k, v]),
      ltrim: (k: string, a: number, b: number) => ops.push(["ltrim", k, a, b]),
      publish: (c: string, v: string) => ops.push(["publish", c, v]),
      exec: async () => ops.map(() => [fail ?? null, "OK"] as [Error | null, unknown]),
    };
    return { ops, redis: { multi: () => m } };
  }

  test("SET latest + LPUSH/LTRIM recent + PUBLISH, in one MULTI", async () => {
    const { ops, redis } = fakeRedis();
    const json = toSignedVenueReportJson(await signed());
    await new RedisReportPublisher(redis, 4).publish(json);
    expect(ops.map((o) => [o[0], o[1]])).toEqual([
      ["set", "bkrn:venue:report:1"],
      ["lpush", "bkrn:venue:report:1:recent"],
      ["ltrim", "bkrn:venue:report:1:recent"],
      ["publish", "bkrn:venue:report:1"],
    ]);
    expect(ops[2]!.slice(2)).toEqual([0, 3]);
    expect(JSON.parse(String(ops[0]![2]))).toEqual(json);
  });

  test("a failed command rejects the publish", async () => {
    const { redis } = fakeRedis(new Error("OOM"));
    await expect(new RedisReportPublisher(redis).publish(toSignedVenueReportJson(await signed()))).rejects.toThrow("OOM");
  });

  test("memory publisher keeps the newest first", async () => {
    const p = new MemoryReportPublisher();
    await p.publish(toSignedVenueReportJson(await signed({ asOf: 1n })));
    await p.publish(toSignedVenueReportJson(await signed({ asOf: 2n })));
    expect(p.recent.get(1)?.map((r) => r.asOf)).toEqual([2, 1]);
  });
});

describe("reportSigned detection (bytecode, through the ERC-1967 proxy)", () => {
  test("selector push encoding", () => {
    expect(REPORT_SIGNED_SELECTOR).toBe(toFunctionSelector("reportSigned(uint256,int256,int256,uint64,bytes)"));
    expect(selectorPush("0x12345678")).toBe("6312345678");
    expect(selectorPush("0x00345678")).toBe("62345678");
  });

  test("resolves the implementation slot, then scans its dispatcher", async () => {
    const impl = "0x00000000000000000000000000000000000c0de1" as Address;
    const sel = REPORT_SIGNED_SELECTOR.slice(2);
    const pc = (code: Hex, proxied = true) => ({
      getStorageAt: async () => (proxied ? (`0x${impl.slice(2).padStart(64, "0")}` as Hex) : (`0x${"0".repeat(64)}` as Hex)),
      getCode: async ({ address }: { address: Address }) => (address.toLowerCase() === impl.toLowerCase() || !proxied ? code : ("0x363d3d37" as Hex)),
    });
    expect(await codeHasSelector(pc(`0x6080604052${"63"}${sel}14610042` as Hex), ADAPTER, REPORT_SIGNED_SELECTOR)).toBe(true);
    expect(await codeHasSelector(pc("0x608060405263deadbeef14" as Hex), ADAPTER, REPORT_SIGNED_SELECTOR)).toBe(false);
    expect(await codeHasSelector(pc(`0x63${sel}` as Hex, false), ADAPTER, REPORT_SIGNED_SELECTOR)).toBe(true);
  });
});

describe("config", () => {
  test("OPS_REPORT_MODE defaults to signed; onchain keeps the old loop; anything else is rejected", () => {
    expect(loadOpsEnv({}).OPS_REPORT_MODE).toBe("signed");
    expect(loadOpsEnv({ OPS_REPORT_MODE: "onchain" }).OPS_REPORT_MODE).toBe("onchain");
    expect(() => loadOpsEnv({ OPS_REPORT_MODE: "both" })).toThrow(/OPS_REPORT_MODE/);
  });

  test("the testnet dev profile runs the low-gas modes (signed reports, pull oracle) and keeps its mark interval", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../scripts/dev.ts"), "utf8");
    const profile = src.slice(src.indexOf('if (network === "testnet")'), src.indexOf("loadEnvFile(\".env\", false)"));
    expect(profile).toContain('OPS_REPORT_MODE: "signed"');
    expect(profile).toContain('ORACLE_PUSH_MODE: "pull"');
    expect(profile).toContain('MARK_INTERVAL_SECONDS: "3600"');
  });
});

void SYMBOL;
