import { describe, expect, test } from "bun:test";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type PriceUpdate, priceTypedData } from "../src/eip712";
import { OraclePriceVerifier, oracleSignerCheck, signedUpdateOf, verifiedOracleMsg } from "../src/oracleVerify";
import type { OraclePriceMsg } from "../src/queues";

const CHAIN = 31337;
const ORACLE = "0x00000000000000000000000000000000000000c1" as Address;
const SIGNER = privateKeyToAccount(keccak256(toHex("oracle-signer")));
const STRANGER = privateKeyToAccount(keccak256(toHex("not-a-signer")));
const NVDA = keccak256(toHex("NVDA"));
const TSLA = keccak256(toHex("TSLA"));

async function signedMsg(over: Partial<PriceUpdate> = {}, who = SIGNER, domain = { chainId: CHAIN, oracle: ORACLE }): Promise<OraclePriceMsg> {
  const u: PriceUpdate = { underlying: NVDA, priceWad: 190n * 10n ** 18n, publishedAt: 1_760_000_000n, held: false, sourceCount: 3, sourcesHash: keccak256(toHex("s")), ...over };
  const signature = await who.signTypedData(priceTypedData(domain.chainId, domain.oracle, u));
  return { priceId: "NVDA", underlying: u.underlying, priceWad: u.priceWad.toString(), price: Number(u.priceWad) / 1e18, publishedAt: Number(u.publishedAt), held: u.held, sourceCount: u.sourceCount, sources: [], sourcesHash: u.sourcesHash, signature };
}

function verifier(signers: Address[] = [SIGNER.address]) {
  let calls = 0;
  const v = new OraclePriceVerifier({
    chainId: CHAIN,
    oracle: ORACLE,
    isOracleSigner: async (a) => {
      calls++;
      return signers.some((s) => s.toLowerCase() === a.toLowerCase());
    },
  });
  return { v, calls: () => calls };
}

describe("verifiedOracleMsg (Redis is not trusted for a price)", () => {
  test("a price signed by an oracle signer is taken from its SIGNED fields", async () => {
    const m = await signedMsg();
    const r = await verifiedOracleMsg({ ...m, price: 1, priceId: "NVDA" }, verifier().v, NVDA); // the unsigned `price` is ignored
    expect("msg" in r && r.msg).toMatchObject({ price: 190, publishedAt: 1_760_000_000, held: false, underlying: NVDA, priceWad: (190n * 10n ** 18n).toString() });
  });

  test("a forged price (any signed field changed after signing) is refused", async () => {
    const m = await signedMsg();
    for (const forged of [{ ...m, priceWad: (191n * 10n ** 18n).toString() }, { ...m, publishedAt: m.publishedAt + 60 }, { ...m, held: true }]) {
      const r = await verifiedOracleMsg(forged, verifier().v, NVDA);
      expect("reason" in r && r.reason).toMatch(/not an oracle signer/);
    }
  });

  test("unsigned, wrongly signed, other-domain and other-underlying prices are refused", async () => {
    const m = await signedMsg();
    const { v } = verifier();
    expect(await verifiedOracleMsg({ ...m, signature: "0x" }, v, NVDA)).toEqual({ reason: "malformed signature" });
    expect(await verifiedOracleMsg({ ...m, signature: undefined }, v, NVDA)).toEqual({ reason: "unsigned oracle price (no EIP-712 signature / signed fields)" });
    expect(await verifiedOracleMsg({ price: 190, publishedAt: 1 }, v, NVDA)).toEqual({ reason: "unsigned oracle price (no EIP-712 signature / signed fields)" });
    expect(await verifiedOracleMsg("garbage", v, NVDA)).toMatchObject({ reason: expect.stringContaining("unsigned") });
    const stranger = await verifiedOracleMsg(await signedMsg({}, STRANGER), v, NVDA);
    expect("reason" in stranger && stranger.reason).toContain(`signed by ${STRANGER.address}`);
    const otherOracle = await verifiedOracleMsg(await signedMsg({}, SIGNER, { chainId: CHAIN, oracle: "0x00000000000000000000000000000000000000c2" }), v, NVDA);
    expect("reason" in otherOracle && otherOracle.reason).toMatch(/not an oracle signer/);
    const otherChain = await verifiedOracleMsg(await signedMsg({}, SIGNER, { chainId: 46630, oracle: ORACLE }), v, NVDA);
    expect("reason" in otherChain && otherChain.reason).toMatch(/not an oracle signer/);
    // a genuine TSLA price is never used as NVDA's
    const tsla = await verifiedOracleMsg(await signedMsg({ underlying: TSLA }), v, NVDA);
    expect("reason" in tsla && tsla.reason).toContain("another underlying");
    expect(await verifiedOracleMsg({ ...m, signature: "0x1234" }, v, NVDA)).toEqual({ reason: "malformed signature" });
  });

  test("verdicts are cached per signed message; an unavailable signer check is not cached", async () => {
    const m = await signedMsg();
    const t = verifier();
    await verifiedOracleMsg(m, t.v, NVDA);
    await verifiedOracleMsg(m, t.v, NVDA);
    expect(t.calls()).toBe(1);
    let up = false;
    const flaky = new OraclePriceVerifier({ chainId: CHAIN, oracle: ORACLE, isOracleSigner: async () => { if (!up) throw new Error("rpc down"); return true; } });
    expect(await verifiedOracleMsg(m, flaky, NVDA)).toEqual({ reason: `signer check unavailable for ${SIGNER.address}: rpc down` });
    up = true;
    expect("msg" in (await verifiedOracleMsg(m, flaky, NVDA))).toBe(true);
  });

  test("signedUpdateOf rejects non-positive prices and malformed fields", async () => {
    const m = await signedMsg();
    expect(signedUpdateOf(m)?.update.priceWad).toBe(190n * 10n ** 18n);
    expect(signedUpdateOf({ ...m, priceWad: "0" })).toBeNull();
    expect(signedUpdateOf({ ...m, priceWad: "x" })).toBeNull();
    expect(signedUpdateOf({ ...m, publishedAt: 0 })).toBeNull();
    expect(signedUpdateOf({ ...m, underlying: "0x12" })).toBeNull();
    expect(signedUpdateOf({ ...m, held: "false" })).toBeNull();
  });
});

describe("oracleSignerCheck", () => {
  test("pinned list: no chain read; a bad address throws with the env name", async () => {
    const c = oracleSignerCheck({ chainId: CHAIN, oracle: ORACLE, pinned: SIGNER.address.toLowerCase(), isSignerOnChain: async () => { throw new Error("unused"); } });
    expect(await c.isOracleSigner(SIGNER.address)).toBe(true);
    expect(await c.isOracleSigner(STRANGER.address)).toBe(false);
    expect(() => oracleSignerCheck({ chainId: CHAIN, oracle: ORACLE, pinned: "nope", pinnedEnv: "AGENT_ORACLE_SIGNERS", isSignerOnChain: async () => true })).toThrow("AGENT_ORACLE_SIGNERS: not an address: nope");
  });

  test("on-chain: cached 60 s, an RPC error propagates and is not cached", async () => {
    let now = 0;
    let reads = 0;
    let fail = true;
    const c = oracleSignerCheck({
      chainId: CHAIN,
      oracle: ORACLE,
      now: () => now,
      isSignerOnChain: async () => {
        reads++;
        if (fail) throw new Error("rpc down");
        return true;
      },
    });
    await expect(c.isOracleSigner(SIGNER.address)).rejects.toThrow("rpc down");
    fail = false;
    expect(await c.isOracleSigner(SIGNER.address)).toBe(true);
    expect(await c.isOracleSigner(SIGNER.address)).toBe(true);
    expect(reads).toBe(2);
    now += 60_001;
    await c.isOracleSigner(SIGNER.address);
    expect(reads).toBe(3);
  });
});

