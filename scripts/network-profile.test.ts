// scripts/dev.ts --network mainnet: the profile pins and the preflight that refuses an incomplete host.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { type Env, MAINNET_EXCLUDED, MAINNET_REQUIRED_ENV, deskKeyEnvFor, mainnetProfile, watchedRoleAddresses } from "./network-profile";

const keys = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);

function hostRoot(dep: object | null, chainConfig: object | null = null): string {
  const root = mkdtempSync(join(tmpdir(), "bkrn-mainnet-"));
  if (dep) {
    mkdirSync(join(root, "contracts/deployments"), { recursive: true });
    writeFileSync(join(root, "contracts/deployments/4663.json"), JSON.stringify(dep));
  }
  if (chainConfig) {
    mkdirSync(join(root, "config/chains"), { recursive: true });
    writeFileSync(join(root, "config/chains/4663.json"), JSON.stringify(chainConfig));
  }
  roots.push(root);
  return root;
}
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GOOD_DEP = { chainId: 4663, network: "mainnet", governance: { timelockController: "0x0000000000000000000000000000000000001234" }, books: [] };

function goodEnv(): Env {
  return {
    RHC_RPC_URL: "https://api-robinhood-mainnet-archive.n.dwellir.com/KEY",
    POSTGRES_PASSWORD: "p@ss",
    REDIS_PASSWORD: "r",
    API_ADMIN_TOKEN: "t",
    WEB_ORIGIN: "https://bookrunner.tech,https://www.bookrunner.tech",
    ORDERLY_BASE_URL: "https://api.orderly.org",
    ORDERLY_BROKER_ID: "bookrunner",
    ORDERLY_BUILDER_KEY_SECRET: "seed",
    ANTHROPIC_API_KEY: "sk",
    ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: { proxy: "0x0000000000000000000000000000000000000f01", basis: "per-token" } }),
    ORACLE_HTTP_SOURCES: JSON.stringify([{ name: "vendor", url: "https://prices.example/{ticker}", pricePath: "price" }]),
    MARK_SIGNER_KMS_KEY_ID: "alias/bkrn-mark",
    RISK_KMS_KEY_ID: "alias/bkrn-risk",
    OPS_VENUE_KMS_KEY_ID: "alias/bkrn-ops",
    JURY_PRIVATE_KEY: keys[0],
    KEEPER_PRIVATE_KEY: keys[1],
    ORACLE_SIGNER_KMS_KEY_ID: "alias/bkrn-oracle",
    // devnet leftovers the profile must override
    CHAIN_ID: "31337",
    MARK_INTERVAL_SECONDS: "300",
    ORDERLY_MODE: "mock",
    DATABASE_URL: "postgres://bookrunner:bookrunner@127.0.0.1:54400/bookrunner",
  };
}

describe("mainnet profile (scripts/dev.ts --network mainnet)", () => {
  test("a complete host passes and the profile pins the mainnet settings", () => {
    const { env, errors } = mainnetProfile(goodEnv(), hostRoot(GOOD_DEP));
    expect(errors).toEqual([]);
    expect(env.CHAIN_ID).toBe("4663");
    expect(env.MARK_INTERVAL_SECONDS).toBe("86400");
    expect(env.ORDERLY_MODE).toBe("live");
    expect(env.ORACLE_SYNTHETIC).toBe("0");
    expect(env.SESSIONS_MODE).toBe("charter");
    expect(env.DEPLOYMENT_FILE).toBe("contracts/deployments/4663.json");
    expect(env.RPC_URL).toBe(goodEnv().RHC_RPC_URL);
    expect(env.DATABASE_URL).toBe("postgres://bookrunner:p%40ss@127.0.0.1:54400/bookrunner_mainnet");
    expect(env.REDIS_URL).toBe("redis://:r@127.0.0.1:63790/0");
  });

  test("simulators, mocks, the gas keeper, the launch script and the web dev server never run", () => {
    for (const p of ["mock-orderly", "trader-sim", "gas-keeper", "launch", "web"]) expect(MAINNET_EXCLUDED.has(p)).toBe(true);
    for (const p of ["oracle", "mark", "risk", "ops-venue", "waterfall", "charter", "api", "indexer", "receipts"]) expect(MAINNET_EXCLUDED.has(p)).toBe(false);
    const { errors } = mainnetProfile(goodEnv(), hostRoot(GOOD_DEP), ["trader-sim"]);
    expect(errors).toEqual(["trader-sim never runs on mainnet"]);
  });

  test("every required env is reported when missing", () => {
    for (const name of MAINNET_REQUIRED_ENV) {
      const e = goodEnv();
      delete e[name];
      expect(mainnetProfile(e, hostRoot(GOOD_DEP)).errors).toContain(`${name} is not set`);
    }
  });

  test("refuses any mnemonic in the environment", () => {
    const { errors } = mainnetProfile({ ...goodEnv(), DEV_MNEMONIC: "test test test test test test test test test test test junk" }, hostRoot(GOOD_DEP));
    expect(errors.some((e) => /mnemonic/.test(e))).toBe(true);
  });

  test("every service role needs its own signer", () => {
    const e = goodEnv();
    delete e.KEEPER_PRIVATE_KEY;
    expect(mainnetProfile(e, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/no signer for role keeper: set KEEPER_KMS_KEY_ID/)]);
    const shared = { ...goodEnv(), KEEPER_PRIVATE_KEY: keys[0] };
    expect(mainnetProfile(shared, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/share one key/)]);
    const both = { ...goodEnv(), JURY_KMS_KEY_ID: "alias/x" };
    expect(mainnetProfile(both, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/pick one signer/)]);
  });

  test("admin material never reaches the mainnet service environment", () => {
    const { errors } = mainnetProfile({ ...goodEnv(), DEPLOYER_PRIVATE_KEY: keys[5], BKRN_ALLOW_ADMIN_KEY: "1" }, hostRoot(GOOD_DEP));
    expect(errors).toHaveLength(2);
  });

  test("local RPC, mock venue, http origins and synthetic-only oracle are refused", () => {
    const { errors } = mainnetProfile(
      { ...goodEnv(), RHC_RPC_URL: "http://127.0.0.1:8547", ORDERLY_BASE_URL: "http://127.0.0.1:4420", WEB_ORIGIN: "http://x", ORACLE_CHAINLINK_FEEDS: "{}" },
      hostRoot(GOOD_DEP),
    );
    expect(errors).toHaveLength(4);
  });

  test("the DeployMainnet record must exist and be a mainnet record", () => {
    expect(mainnetProfile(goodEnv(), hostRoot(null)).errors).toEqual([expect.stringMatching(/4663.json not found/)]);
    const testnetDep = { ...GOOD_DEP, chainId: 46630, network: undefined };
    expect(mainnetProfile(goodEnv(), hostRoot(testnetDep)).errors).toHaveLength(2);
  });

  test("Chainlink feeds come from the chain price config the oracle loads (config/chains/4663.json)", () => {
    const e = { ...goodEnv(), ORACLE_CHAINLINK_FEEDS: "{}" };
    const cfg = { chainId: 4663, stockTokens: {}, chainlink: { feeds: { NVDA: { proxy: "0x0000000000000000000000000000000000000f01", basis: "per-token" } } } };
    expect(mainnetProfile(e, hostRoot(GOOD_DEP, cfg)).errors).toEqual([]);
    expect(mainnetProfile(e, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/no Chainlink feed/)]);
    expect(mainnetProfile(e, hostRoot(GOOD_DEP, { ...cfg, chainId: 46630 })).errors).toEqual([
      expect.stringMatching(/not 4663/),
      expect.stringMatching(/no Chainlink feed/),
    ]);
    expect(mainnetProfile({ ...e, ORACLE_CHAIN_CONFIG: "config/chains/missing.json" }, hostRoot(GOOD_DEP, cfg)).errors).toEqual([
      expect.stringMatching(/ORACLE_CHAIN_CONFIG config\/chains\/missing.json not found/),
      expect.stringMatching(/no Chainlink feed/),
    ]);
  });

  test("oracle production rules: feeds state their basis, and an independent source exists", () => {
    const plain = { ...goodEnv(), ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: "0x0000000000000000000000000000000000000f01" }) };
    expect(mainnetProfile(plain, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/plain addresses for NVDA/)]);
    const chainlinkOnly = { ...goodEnv(), ORACLE_HTTP_SOURCES: "[]" };
    expect(mainnetProfile(chainlinkOnly, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/no independent oracle source/)]);
    expect(mainnetProfile({ ...chainlinkOnly, ORACLE_HTTP_FINNHUB: "1" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
  });

  test("alerts watch role ADDRESSES: local keys and per-book desk keys derived, KMS roles left to dev.ts", () => {
    const env: Env = { ...goodEnv(), CHAIN_ID: "4663", DESK_KEY_PRIVATE_KEY_7: keys[2], DESK_KEY_PRIVATE_KEY_x: keys[3] };
    const { pairs, kmsRoles } = watchedRoleAddresses(env, ["markSigner", "risk", "opsVenue", "jury", "keeper", "oracleSigner", "funder", "trader0"]);
    expect(kmsRoles).toEqual(["markSigner", "risk", "opsVenue", "oracleSigner"]);
    expect(pairs).toEqual([
      `jury=${privateKeyToAccount(keys[0] as `0x${string}`).address}`,
      `keeper=${privateKeyToAccount(keys[1] as `0x${string}`).address}`,
      `deskKeyBook7=${privateKeyToAccount(keys[2] as `0x${string}`).address}`,
    ]);
    // never a key in the output
    for (const k of keys) expect(pairs.join(",")).not.toContain(k.slice(2));
  });

  test("a per-book desk key reaches that book's agent only", () => {
    const env = { DESK_KEY_PRIVATE_KEY_7: keys[2], DESK_KEY_PRIVATE_KEY_8: keys[3] };
    expect(deskKeyEnvFor(env, 7)).toEqual({ DESK_KEY_PRIVATE_KEY: keys[2]! });
    expect(deskKeyEnvFor(env, 9)).toEqual({});
  });
});
