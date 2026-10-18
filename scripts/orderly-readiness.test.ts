// scripts/orderly-readiness.ts: pure row logic (no network).
import { describe, expect, test } from "bun:test";
import { type Address, zeroAddress } from "viem";
import {
  type AdapterFacts,
  PROFILES,
  type Row,
  accountRows,
  adapterEmpty,
  bookRows,
  brokerRows,
  builderKeyRows,
  builderSymbol,
  chainInfoRows,
  charterBase,
  defaultDeploymentFile,
  deploymentRows,
  exitCode,
  orderlyHash,
  parseStages,
  recordRows,
  symbolRows,
  tokenRows,
  vaultRows,
} from "./orderly-readiness";

const T = PROFILES.testnet;
const M = PROFILES.mainnet;
const status = (rows: Row[], check: string) => rows.find((r) => r.check === check)?.status;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("hashes and symbols", () => {
  test("Orderly string hashes (VERIFY O7)", () => {
    expect(orderlyHash("USDC")).toBe("0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa");
    expect(orderlyHash("USDG")).toBe("0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea");
    expect(orderlyHash("bookrunner")).toBe("0x83c328a842cde1f424b861fd7dbb8c437c757ac45881c6bc6e72697b898b9aba");
  });

  test("builder symbol naming PERP_<BASE>_USDC_<broker>", () => {
    expect(builderSymbol("nvda", "bookrunner")).toBe("PERP_NVDA_USDC_bookrunner");
    // invalid base / broker id: shown as is, so the row names what was asked for (and stays FAIL: not listed)
    expect(builderSymbol("NV DA", "bookrunner")).toBe("PERP_NV DA_USDC_bookrunner");
    expect(builderSymbol("NVDA", "Book Runner")).toBe("PERP_NVDA_USDC_Book Runner");
    expect(symbolRows("Book Runner", ["NVDA"], [])[0]).toMatchObject({ check: "symbol PERP_NVDA_USDC_Book Runner", status: "FAIL" });
    expect(charterBase("PERP_NVDA_USDC")).toBe("NVDA");
    expect(charterBase("PERP_NVDA_USDC_bookrunner")).toBe("NVDA");
  });
});

describe("venue rows", () => {
  const ok = { code: "0x60" as const, allowedToken: T.token.address, allowedBroker: true, tokenDecimals: 6, tokenCode: "0x60" as const };

  test("all enabled -> PASS", () => {
    const rows = vaultRows(T, "bookrunner", ok);
    expect(rows.every((r) => r.status === "PASS")).toBe(true);
  });

  test("testnet 2026-10-18: no allowed token, broker not allowed", () => {
    const rows = vaultRows(T, "bookrunner", { ...ok, allowedToken: zeroAddress, allowedBroker: false, allowedUsdc: zeroAddress });
    expect(status(rows, "vault code")).toBe("PASS");
    expect(status(rows, "allowed token USDG")).toBe("FAIL");
    expect(rows.find((r) => r.check === "allowed token USDG")?.detail).toContain("allows no USDG");
    expect(status(rows, "allowed broker bookrunner")).toBe("FAIL");
    expect(status(rows, "allowed token USDC")).toBe("INFO");
  });

  test("missing vault code, wrong token, failed reads, wrong decimals", () => {
    const rows = vaultRows(T, "bookrunner", { code: "0x", allowedToken: A(5), allowedBroker: null, tokenDecimals: 18, tokenCode: "0x60" });
    expect(status(rows, "vault code")).toBe("FAIL");
    expect(status(rows, "allowed token USDG")).toBe("FAIL");
    expect(status(rows, "allowed broker bookrunner")).toBe("FAIL");
    expect(status(rows, "USDG on-chain")).toBe("FAIL");
    expect(status(vaultRows(T, "bookrunner", { ...ok, allowedToken: null }), "allowed token USDG")).toBe("FAIL");
  });

  test("chain_info: absent chain, vault mismatch, broker list", () => {
    const absent = chainInfoRows(T, "bookrunner", [{ chain_id: "421614", vault_address: A(1), broker_ids: ["bookrunner"] }]);
    expect(absent.map((r) => r.status)).toEqual(["FAIL", "FAIL"]);
    expect(absent[0]!.detail).toContain("46630 absent");
    const good = chainInfoRows(M, "bookrunner", [{ chain_id: "4663", name: "Robinhood Chain", vault_address: M.vault.toLowerCase(), broker_ids: ["bookrunner", "mythos"] }]);
    expect(good.map((r) => r.status)).toEqual(["PASS", "PASS"]);
    const noBroker = chainInfoRows(M, "bookrunner", [{ chain_id: 4663, vault_address: M.vault, broker_ids: ["mythos"] }]);
    expect(noBroker.map((r) => r.status)).toEqual(["PASS", "FAIL"]);
    const wrongVault = chainInfoRows(M, "bookrunner", [{ chain_id: 4663, vault_address: A(9), broker_ids: ["bookrunner"] }]);
    expect(wrongVault[0]!.status).toBe("FAIL");
    expect(chainInfoRows(T, "bookrunner", new Error("timeout"))[0]!.status).toBe("FAIL");
  });

  test("token list: chain detail, contract and decimals", () => {
    const usdg = (chain: string, addr: string, decimals: number) => [{ token: "USDG", token_hash: orderlyHash("USDG"), decimals: 6, chain_details: [{ chain_id: chain, contract_address: addr, decimals }] }];
    expect(tokenRows(M, usdg("4663", M.token.address.toLowerCase(), 6))[0]!.status).toBe("PASS");
    expect(tokenRows(M, usdg("4663", M.token.address, 18))[0]!.status).toBe("FAIL");
    expect(tokenRows(M, usdg("4663", A(3), 6))[0]!.status).toBe("FAIL");
    expect(tokenRows(T, usdg("4663", M.token.address, 6))[0]!.detail).toContain("not for chain 46630");
    expect(tokenRows(T, [{ token: "USDC" }])[0]!.status).toBe("FAIL");
  });
});

describe("builder rows", () => {
  test("broker name and admin account", () => {
    expect(brokerRows("bookrunner", [{ broker_id: "bookrunner", broker_name: "bookrunner" }])[0]!.status).toBe("PASS");
    expect(brokerRows("bookrunner", [{ broker_id: "mythos" }])[0]!.status).toBe("FAIL");
    expect(accountRows("bookrunner", A(1), { success: true, data: { account_id: "0xaa04", user_id: 1 } })[0]!.status).toBe("PASS");
    const missing = accountRows("bookrunner", A(1), { success: false, code: -1614, message: "brokerId is not exist" });
    expect(missing[0]!.status).toBe("FAIL");
    expect(missing[0]!.detail).toContain("-1614");
  });

  test("builder key: skipped without a key, expiry checked", () => {
    expect(builderKeyRows(undefined, null)[0]!.status).toBe("SKIP");
    expect(builderKeyRows("ed25519:abc", { success: true, data: { orderly_key: "ed25519:abc", scope: "read,trading", expiration: 2_000 } }, 1_000)[0]!.status).toBe("PASS");
    expect(builderKeyRows("ed25519:abc", { success: true, data: { orderly_key: "ed25519:abc", expiration: 500 } }, 1_000)[0]!.status).toBe("FAIL");
    expect(builderKeyRows("ed25519:abc", { success: true })[0]!.status).toBe("FAIL");
  });

  test("symbols: missing FAIL, not-yet-active WARN, ACTIVE PASS; equities listed", () => {
    const rows = symbolRows("bookrunner", ["NVDA", "TSLA", "AAPL"], [
      { symbol: "PERP_NVDA_USDC_bookrunner", status: "ACTIVE" },
      { symbol: "PERP_TSLA_USDC_bookrunner", status: "PENDING" },
      { symbol: "PERP_TSLA_USDC", status: "ACTIVE" },
      { symbol: "PERP_AAPL_USDC_mythos", status: "ACTIVE" },
      { symbol: "PERP_ETH_USDC", status: "ACTIVE" },
    ]);
    expect(status(rows, "symbol PERP_NVDA_USDC_bookrunner")).toBe("PASS");
    expect(status(rows, "symbol PERP_TSLA_USDC_bookrunner")).toBe("WARN");
    expect(status(rows, "symbol PERP_AAPL_USDC_bookrunner")).toBe("FAIL");
    const eq = rows.find((r) => r.check === "equity symbols")!;
    expect(eq.status).toBe("INFO");
    expect(eq.detail).toContain("PERP_AAPL_USDC_mythos");
    expect(eq.detail).toContain("PERP_TSLA_USDC_bookrunner:PENDING");
    expect(eq.detail).not.toContain("PERP_ETH_USDC");
    expect(status(symbolRows("bookrunner", ["NVDA"], [{ symbol: "PERP_NVDA_USDC_bookrunner", status: "DELISTED" }]), "symbol PERP_NVDA_USDC_bookrunner")).toBe("FAIL");
  });
});

describe("book rows", () => {
  const real: AdapterFacts = {
    orderlyVault: T.vault,
    usdc: T.token.address,
    tokenHash: orderlyHash("USDG"),
    brokerHash: orderlyHash("bookrunner"),
    ifAccount: A(7),
    delegateSigner: A(8),
    insuranceUsd: 0n,
    marginUsd: 0n,
    inTransitUsd: 0n,
    pendingIfUsd: 0n,
    pendingMmUsd: 0n,
  };
  const book = { bookId: 1, name: "NVDA", symbol: "PERP_NVDA_USDC", adapter: A(42) };

  test("a v3 adapter on the real vault with USDG passes; its IF row: INFO before the window closes", () => {
    const rows = bookRows(T, "bookrunner", book, real);
    expect(rows.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS", "INFO"]);
    expect(rows[3]!.check).toBe("book 1 NVDA IF funded");
    expect(rows[3]!.detail).toContain("PERP_NVDA_USDC_bookrunner");
    expect(rows[3]!.detail).toContain("deposited at window close");
    expect(bookRows(T, "bookrunner", book, { ...real, bookState: 0 })[3]!.status).toBe("INFO");
  });

  test("live-venue book: IF funded strictly above the requirement (testnet 100 USDG), FAIL once Live / Retiring", () => {
    const live = (insuranceUsd: bigint, bookState: number) => bookRows(T, "bookrunner", book, { ...real, insuranceUsd, bookState })[3]!;
    expect(live(150_000_000n, 2)).toMatchObject({ status: "PASS" });
    expect(live(150_000_000n, 2).detail).toContain("insurance 150 USD");
    expect(live(100_000_000n, 2).status).toBe("FAIL"); // exactly the requirement is not enough
    expect(live(100_000_000n, 3).status).toBe("FAIL");
    expect(live(0n, 4).status).toBe("INFO"); // Retired: recalled
    expect(bookRows(M, "bookrunner", book, { ...real, orderlyVault: M.vault, usdc: M.token.address, insuranceUsd: 25_000_000_000n, bookState: 2 })[3]!.status).toBe("FAIL");
    expect(bookRows(T, "bookrunner", book, { ...real, ifAccountOwner: A(0xe0a) })[2]!.detail).toContain("builder EOA");
    expect(bookRows(T, "bookrunner", book, { ...real, ifAccountOwner: zeroAddress })[2]!.detail).toContain("contract 0x000000");
  });

  test("record rows: the live-venue record passes; mock / another vault / token / broker FAIL; no block is INFO", () => {
    const o = { venue: "live" as const, vault: T.vault, brokerId: "bookrunner", token: "USDG", settlementToken: T.token.address };
    const contracts = { usdc: T.token.address, orderlyVault: T.vault } as never;
    expect(recordRows(T, "bookrunner", "r.json", { orderly: o, contracts })).toEqual([expect.objectContaining({ check: "record orderly", status: "PASS" })]);
    const bad = recordRows(T, "bookrunner", "r.json", { orderly: { ...o, venue: "mock", vault: A(0xc488), settlementToken: A(0x04de), token: "USDC" }, contracts: { usdc: A(0x04de), orderlyVault: A(0xc488) } as never })[0]!;
    expect(bad.status).toBe("FAIL");
    for (const part of ["venue mock", "vault 0x", "settlement token", "token symbol USDC != USDG"]) expect(bad.detail).toContain(part);
    expect(recordRows(T, "other", "r.json", { orderly: o, contracts })[0]!.detail).toContain("broker bookrunner != other");
    expect(recordRows(T, "bookrunner", "r.json", { orderly: o, contracts: { usdc: A(1), orderlyVault: T.vault } as never })[0]!.detail).toContain("disagree");
    expect(recordRows(T, "bookrunner", "r.json", { contracts } as never)[0]!.status).toBe("INFO");
    expect(recordRows(T, "bookrunner", "r.json", null)).toEqual([]);
  });

  test("default record: the live rehearsal record when present (testnet), else the network's", () => {
    expect(defaultDeploymentFile(T, () => true)).toBe("contracts/deployments/46630.live.json");
    expect(defaultDeploymentFile(T, () => false)).toBe("contracts/deployments/46630.json");
    expect(defaultDeploymentFile(M, () => true)).toBe("contracts/deployments/4663.json");
  });

  test("today's testnet book: mock vault, mock USDC, devnet accounts, funded", () => {
    const mock: AdapterFacts = { ...real, orderlyVault: A(0xc488), usdc: A(0x04de), tokenHash: orderlyHash("USDC"), ifAccount: zeroAddress, insuranceUsd: 30_000_000_000n, marginUsd: 134_168_380_000n };
    const rows = bookRows(T, "bookrunner", book, mock);
    expect(rows.map((r) => r.status)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL"]);
    expect(rows[0]!.detail).toContain("MOCK vault");
    expect(rows[2]!.detail).toContain("migrateToOrderlyAccounts");
    expect(rows[3]!.detail).toContain("IF 30,000");
    expect(bookRows(T, "bookrunner", book, { ...mock, ifAccount: null })[2]!.detail).toContain("pre-v3");
  });

  test("emptiness = the migration rule (every venue-side / in-flight amount zero)", () => {
    expect(adapterEmpty(real)).toBe(true);
    for (const k of ["insuranceUsd", "marginUsd", "inTransitUsd", "pendingIfUsd", "pendingMmUsd"] as const) expect(adapterEmpty({ ...real, [k]: 1n })).toBe(false);
    expect(adapterEmpty({ ...real, marginUsd: -5n })).toBe(false);
  });

  test("read failure is a FAIL", () => {
    expect(bookRows(T, "bookrunner", book, new Error("revert"))[0]!.status).toBe("FAIL");
  });

  test("deployment rows: absent file skipped, mock settlement FAILs", () => {
    expect(deploymentRows(T, "bookrunner", "x.json", null)[0]!.status).toBe("SKIP");
    const good = deploymentRows(T, "bookrunner", "x.json", { configUsdc: T.token.address, configVault: T.vault, implTokenHash: orderlyHash("USDG"), implBrokerHash: orderlyHash("bookrunner") });
    expect(good.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS"]);
    const mock = deploymentRows(T, "bookrunner", "x.json", { configUsdc: A(1), configVault: A(2), implTokenHash: orderlyHash("USDC"), implBrokerHash: orderlyHash("bookrunner") });
    expect(mock.map((r) => r.status)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(deploymentRows(T, "bookrunner", "x.json", { configUsdc: null, configVault: null, implTokenHash: null, implBrokerHash: null, error: "chainId 1 != 46630" })[0]!.status).toBe("FAIL");
  });
});

describe("exit code and stages", () => {
  const rows: Row[] = [
    { stage: "venue", check: "a", status: "PASS", detail: "" },
    { stage: "builder", check: "b", status: "WARN", detail: "" },
    { stage: "books", check: "c", status: "FAIL", detail: "" },
    { stage: "books", check: "d", status: "SKIP", detail: "" },
  ];
  test("FAIL gates, WARN / INFO / SKIP do not; stage filter", () => {
    expect(exitCode(rows)).toBe(1);
    expect(exitCode(rows, ["venue", "builder"])).toBe(0);
    expect(exitCode(rows.filter((r) => r.status !== "FAIL"))).toBe(0);
  });
  test("parseStages", () => {
    expect(parseStages(undefined)).toEqual(["venue", "builder", "books"]);
    expect(parseStages("venue,books")).toEqual(["venue", "books"]);
    expect(() => parseStages("venue,nope")).toThrow("unknown stage");
  });
});
