// scripts/dev.ts --network mainnet: the profile pins and the preflight that refuses an incomplete host.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { type Env, MAINNET_EXCLUDED, MAINNET_FIXED, MAINNET_REQUIRED_ENV, MAINNET_RPC_BOUNDS, MAINNET_RPC_DEFAULTS, deskKeyEnvFor, mainnetProfile, mainnetRpcCadence, mainnetWsUrl, watchedRoleAddresses } from "./network-profile";

/** The repo's mainnet price config: a Chainlink feed and a DEX confirm pool per launch ticker. */
const GOOD_CFG = JSON.parse(readFileSync(join(import.meta.dir, "../config/chains/4663.json"), "utf8")) as {
  chainId: number;
  chainlink: { feeds: Record<string, unknown> };
  dexConfirm: { pools: Record<string, { pool: string; minDepthUsd: number; twapSec: number }> };
};

const keys = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);

function hostRoot(dep: object | null, chainConfig: object | null = GOOD_CFG): string {
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
    WATERFALL_LIQ_ETH_USD: "3000",
    // overlays the chain config's NVDA feed (primary-confirm: Chainlink signs, the DEX TWAP of the config confirms)
    ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: { proxy: "0x0000000000000000000000000000000000000f01", basis: "per-token" } }),
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
    expect(env.ORACLE_POLICY).toBe("primary-confirm");
    expect(env.ORACLE_MIN_SOURCES).toBe("1");
    expect(MAINNET_FIXED.ORACLE_POLICY).toBe("primary-confirm");
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

  test("builder IF mode (fallback, VERIFY O10) is refused on mainnet without the owner's sign-off flag", () => {
    expect(mainnetProfile({ ...goodEnv(), ORDERLY_IF_MODE: "builder" }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/ORDERLY_IF_MODE=builder is not for mainnet without the owner's explicit sign-off/)]);
    expect(mainnetProfile({ ...goodEnv(), ORDERLY_IF_MODE: "builder", ORDERLY_IF_MODE_BUILDER_ACK: "1" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile({ ...goodEnv(), ORDERLY_IF_MODE: "contract" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
  });

  test("local RPC, mock venue, http origins and synthetic-only oracle are refused", () => {
    const { errors } = mainnetProfile(
      { ...goodEnv(), RHC_RPC_URL: "http://127.0.0.1:8547", ORDERLY_BASE_URL: "http://127.0.0.1:4420", WEB_ORIGIN: "http://x", ORACLE_CHAINLINK_FEEDS: "{}" },
      hostRoot(GOOD_DEP, null),
    );
    expect(errors).toEqual([
      expect.stringMatching(/RHC_RPC_URL points at a local node/),
      expect.stringMatching(/WEB_ORIGIN must list https/),
      expect.stringMatching(/ORDERLY_BASE_URL must be the live Orderly API/),
      expect.stringMatching(/no Chainlink feed: .*only signing source/),
      expect.stringMatching(/no DEX confirm pool for NVDA, TSLA, AAPL, MSFT, AMZN/),
    ]);
  });

  test("the DeployMainnet record must exist and be a mainnet record", () => {
    expect(mainnetProfile(goodEnv(), hostRoot(null)).errors).toEqual([expect.stringMatching(/4663.json not found/)]);
    const testnetDep = { ...GOOD_DEP, chainId: 46630, network: undefined };
    expect(mainnetProfile(goodEnv(), hostRoot(testnetDep)).errors).toHaveLength(2);
  });

  test("Chainlink feeds and DEX confirm pools come from the chain price config the oracle loads (config/chains/4663.json)", () => {
    const e = { ...goodEnv(), ORACLE_CHAINLINK_FEEDS: "{}" };
    expect(mainnetProfile(e, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile(e, hostRoot(GOOD_DEP, null)).errors).toEqual([expect.stringMatching(/no Chainlink feed/), expect.stringMatching(/no DEX confirm pool/)]);
    expect(mainnetProfile(e, hostRoot(GOOD_DEP, { ...GOOD_CFG, chainId: 46630 })).errors).toEqual([
      expect.stringMatching(/not 4663/),
      expect.stringMatching(/no Chainlink feed/),
      expect.stringMatching(/no DEX confirm pool/),
    ]);
    expect(mainnetProfile({ ...e, ORACLE_CHAIN_CONFIG: "config/chains/missing.json" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_CHAIN_CONFIG config\/chains\/missing.json not found/),
      expect.stringMatching(/no Chainlink feed/),
      expect.stringMatching(/no DEX confirm pool/),
    ]);
  });

  test("primary-confirm rules: a Chainlink feed and a DEX confirm pool (real floor) for every ticker", () => {
    const { AMZN: _f, ...fourFeeds } = GOOD_CFG.chainlink.feeds;
    const noAmznFeed = { ...GOOD_CFG, chainlink: { ...GOOD_CFG.chainlink, feeds: fourFeeds } };
    expect(mainnetProfile(goodEnv(), hostRoot(GOOD_DEP, noAmznFeed)).errors).toEqual([
      "no Chainlink feed for AMZN (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS)",
    ]);
    const { TSLA: _p, ...fourPools } = GOOD_CFG.dexConfirm.pools;
    const noTslaPool = { ...GOOD_CFG, dexConfirm: { ...GOOD_CFG.dexConfirm, pools: fourPools } };
    expect(mainnetProfile(goodEnv(), hostRoot(GOOD_DEP, noTslaPool)).errors).toEqual(["no DEX confirm pool for TSLA (config/chains/4663.json dexConfirm.pools)"]);
    const shallow = { ...GOOD_CFG, dexConfirm: { ...GOOD_CFG.dexConfirm, pools: { ...GOOD_CFG.dexConfirm.pools, AAPL: { ...GOOD_CFG.dexConfirm.pools.AAPL!, minDepthUsd: 500 } } } };
    expect(mainnetProfile(goodEnv(), hostRoot(GOOD_DEP, shallow)).errors).toEqual(["dexConfirm.pools.AAPL.minDepthUsd must be >= 10000 (got 500)"]);
    // a narrower ticker list only needs its own feeds / pools
    expect(mainnetProfile({ ...goodEnv(), ORACLE_TICKERS: "NVDA,TSLA" }, hostRoot(GOOD_DEP, noAmznFeed)).errors).toEqual([]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_TICKERS: "NVDA,GME" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/no Chainlink feed for GME/),
      expect.stringMatching(/no DEX confirm pool for GME/),
    ]);
    // the DEX confirm cannot be switched off
    expect(mainnetProfile({ ...goodEnv(), ORACLE_DEX_CONFIRM: "0" }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/ORACLE_DEX_CONFIRM is off/)]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_DEX_CONFIRM: "yes" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    // feeds state their basis
    const plain = { ...goodEnv(), ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: "0x0000000000000000000000000000000000000f01" }) };
    expect(mainnetProfile(plain, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/plain addresses for NVDA/)]);
  });

  test("freshness and DEX bounds: Chainlink max age <= heartbeat + 1 h, DEX TWAP 300-3600 s, DEX max age <= 120 s, lag < confirm", () => {
    const ok = (e: Env) => expect(mainnetProfile({ ...goodEnv(), ...e }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    const bad = (e: Env, re: RegExp) => expect(mainnetProfile({ ...goodEnv(), ...e }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(re)]);
    ok({ ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS: "3600000", ORACLE_CHAINLINK_MAX_AGE_MS: "90000000" });
    bad({ ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS: "172800000" }, /ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS=172800000 must be <= 3600000/);
    bad({ ORACLE_CHAINLINK_MAX_AGE_MS: "90000001" }, /ORACLE_CHAINLINK_MAX_AGE_MS=90000001 must be <= 90000000/);
    const feeds = (over: Record<string, unknown>) =>
      JSON.stringify({ NVDA: { proxy: "0x0000000000000000000000000000000000000f01", basis: "per-token", heartbeatSec: 86_400, ...over } });
    ok({ ORACLE_CHAINLINK_FEEDS: feeds({ maxAgeSec: 90_000 }) });
    bad({ ORACLE_CHAINLINK_FEEDS: feeds({ maxAgeSec: 172_800 }) }, /chainlink feed NVDA: maxAgeSec=172800 > heartbeat 86400 s \+ 1 h/);
    // the chain config's own feeds are bounded too
    const cfgWide = { ...GOOD_CFG, chainlink: { ...GOOD_CFG.chainlink, feeds: { ...GOOD_CFG.chainlink.feeds, TSLA: { ...(GOOD_CFG.chainlink.feeds.TSLA as object), maxAgeSec: 200_000 } } } };
    expect(mainnetProfile(goodEnv(), hostRoot(GOOD_DEP, cfgWide)).errors).toEqual([expect.stringMatching(/chainlink feed TSLA: maxAgeSec=200000/)]);
    ok({ ORACLE_DEX_TWAP_SEC: "300", ORACLE_DEX_MAX_AGE_MS: "120000", ORACLE_PRIMARY_LAG_BPS: "150" });
    bad({ ORACLE_DEX_TWAP_SEC: "60" }, /ORACLE_DEX_TWAP_SEC=60 outside 300-3600 s/);
    bad({ ORACLE_DEX_MAX_AGE_MS: "600000" }, /ORACLE_DEX_MAX_AGE_MS=600000 must be in \(0, 120000\]/);
    bad({ ORACLE_PRIMARY_LAG_BPS: "250" }, /ORACLE_PRIMARY_LAG_BPS=250 must be positive and below ORACLE_CONFIRM_BPS \(200\)/);
    const shortTwap = { ...GOOD_CFG, dexConfirm: { ...GOOD_CFG.dexConfirm, pools: { ...GOOD_CFG.dexConfirm.pools, MSFT: { ...GOOD_CFG.dexConfirm.pools.MSFT!, twapSec: 120 } } } };
    expect(mainnetProfile(goodEnv(), hostRoot(GOOD_DEP, shortTwap)).errors).toEqual(["dexConfirm.pools.MSFT.twapSec=120 outside 300-3600 s on mainnet"]);
  });

  test("ORACLE_POLICY / ORACLE_MIN_SOURCES are pinned; a contradicting value is refused, not silently overridden", () => {
    expect(mainnetProfile({ ...goodEnv(), ORACLE_POLICY: "primary-confirm", ORACLE_MIN_SOURCES: "1" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_POLICY: "median" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_POLICY=median contradicts the mainnet profile \(primary-confirm/),
    ]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_MIN_SOURCES: "2" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_MIN_SOURCES=2 contradicts the mainnet profile \(1: primary-confirm signs every price with sourceCount 1\)/),
    ]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_CONFIRM_BPS: "800" }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/ORACLE_CONFIRM_BPS=800 must be in \(0, 500\]/)]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_CONFIRM_BPS: "150" }, hostRoot(GOOD_DEP)).errors).toEqual([]);
  });

  test("optional confirmers: Pyth Pro only with its token over https; HTTP specs timestamped and tight; no Finnhub", () => {
    const pyth = { ...goodEnv(), ORACLE_PYTH: "1", PYTH_API_KEY: "pyth-test-token" };
    expect(mainnetProfile(pyth, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_PYTH: "yes" }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/ORACLE_PYTH=1 but PYTH_API_KEY is not set/)]);
    expect(mainnetProfile({ ...pyth, ORACLE_PYTH_FEEDS: '{"NVDA":"x"}' }, hostRoot(GOOD_DEP)).errors).toEqual([expect.stringMatching(/ORACLE_PYTH_FEEDS is not a JSON object/)]);
    expect(mainnetProfile({ ...pyth, ORACLE_PYTH_FEEDS: '{"NVDA":1314}' }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile({ ...pyth, ORACLE_PYTH_URL: "http://pyth.example/v1/latest_price" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_PYTH_URL must be https:\/\//),
    ]);
    const spec = (over: Record<string, unknown>) =>
      JSON.stringify([{ name: "vendor", url: "https://prices.example/{ticker}", pricePath: "price", tsPath: "ts", maxAgeMs: 10_000, ...over }]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_HTTP_SOURCES: spec({}) }, hostRoot(GOOD_DEP)).errors).toEqual([]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_HTTP_SOURCES: spec({ tsPath: undefined }) }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_HTTP_SOURCES.vendor has no tsPath/),
    ]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_HTTP_SOURCES: spec({ maxAgeMs: 60_000 }) }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_HTTP_SOURCES.vendor needs maxAgeMs <= 30000/),
    ]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_HTTP_FINNHUB: "1" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_HTTP_FINNHUB=1 but ORACLE_FINNHUB_API_KEY is not set/),
    ]);
    expect(mainnetProfile({ ...goodEnv(), ORACLE_HTTP_FINNHUB: "1", ORACLE_FINNHUB_API_KEY: "f" }, hostRoot(GOOD_DEP)).errors).toEqual([
      expect.stringMatching(/ORACLE_HTTP_FINNHUB is not a mainnet source/),
    ]);
    // the access token is never echoed in an error
    for (const e of mainnetProfile({ ...pyth, ORACLE_MIN_SOURCES: "9", ORACLE_PYTH_URL: "http://x" }, hostRoot(GOOD_DEP)).errors) expect(e).not.toContain("pyth-test-token");
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

describe("mainnet RPC budget (deploy/server/MAINNET.md \"RPC budget\")", () => {
  test("the profile applies the mainnet cadence defaults; an operator's value within bounds wins", () => {
    const { env, errors } = mainnetProfile(goodEnv(), hostRoot(GOOD_DEP));
    expect(errors).toEqual([]);
    for (const [k, v] of Object.entries(MAINNET_RPC_DEFAULTS)) expect(env[k]).toBe(v);
    expect(env.INDEXER_POLL_MS).toBe("12000");
    expect(env.OPS_LOG_POLL_MS).toBe("30000");
    expect(env.OPS_BOOK_POLL_MS).toBe("60000");
    // safety-bound cadences are not slowed down by the profile (service defaults stay)
    for (const k of ["RISK_INTERVAL_MS", "OPS_REPORT_INTERVAL_MS", "OPS_TX_POLL_MS", "ORACLE_TICK_MS"]) expect(env[k]).toBeUndefined();
    // an explicit value is the operator's (not in the profile env: the inherited value stands)
    const own = mainnetProfile({ ...goodEnv(), INDEXER_POLL_MS: "6000" }, hostRoot(GOOD_DEP));
    expect(own.errors).toEqual([]);
    expect(own.env.INDEXER_POLL_MS).toBeUndefined();
    // every default lies within its own bound
    for (const [k, v] of Object.entries(MAINNET_RPC_DEFAULTS)) {
      const b = MAINNET_RPC_BOUNDS[k];
      expect(b).toBeDefined();
      expect(Number(v) >= b!.min && Number(v) <= b!.max).toBe(true);
    }
  });

  test("a misconfiguration is refused on mainnet (a 100 ms oracle tick, hot pollers, broken relations)", () => {
    const errs = (e: Env) => mainnetProfile({ ...goodEnv(), ...e }, hostRoot(GOOD_DEP)).errors;
    expect(errs({ ORACLE_TICK_MS: "100" })).toEqual([expect.stringMatching(/^ORACLE_TICK_MS=100 must be within 1000-5000 on mainnet/)]);
    expect(errs({ ORACLE_CHAINLINK_READ_MS: "100", ORACLE_TOKEN_STATE_READ_MS: "100" })).toEqual([
      expect.stringMatching(/^ORACLE_CHAINLINK_READ_MS=100 must be within 2000-30000/),
      expect.stringMatching(/^ORACLE_TOKEN_STATE_READ_MS=100 must be within 2000-60000/),
    ]);
    expect(errs({ INDEXER_POLL_MS: "500" })).toEqual([expect.stringMatching(/^INDEXER_POLL_MS=500 must be within 2000-60000/)]);
    expect(errs({ OPS_LOG_POLL_MS: "abc" })).toEqual([expect.stringMatching(/^OPS_LOG_POLL_MS=abc must be within/)]);
    expect(errs({ RISK_INTERVAL_MS: "30000" })).toEqual([expect.stringMatching(/^RISK_INTERVAL_MS=30000 must be within 1000-5000.*kill-path latency/)]);
    expect(errs({ OPS_TX_POLL_MS: "50" })).toEqual([expect.stringMatching(/^OPS_TX_POLL_MS=50/)]);
    expect(errs({ ORACLE_DEX_READ_MS: "120000" })).toEqual([
      expect.stringMatching(/^ORACLE_DEX_READ_MS=120000 must be within 10000-60000/),
      expect.stringMatching(/^ORACLE_DEX_READ_MS=120000 must be at most half ORACLE_DEX_MAX_AGE_MS/),
    ]);
    expect(errs({ ORACLE_DEX_MAX_AGE_MS: "100000" })).toEqual([expect.stringMatching(/^ORACLE_DEX_READ_MS=60000 must be at most half ORACLE_DEX_MAX_AGE_MS \(100000\)/)]);
    expect(errs({ ORACLE_CHAINLINK_READ_MS: "20000", ORACLE_TOKEN_STATE_READ_MS: "10000" })).toEqual([expect.stringMatching(/^ORACLE_TOKEN_STATE_READ_MS=10000 below ORACLE_CHAINLINK_READ_MS \(20000\)/)]);
    // the mark must still wait for the waterfall's distribution
    expect(errs({ WATERFALL_TICK_SECONDS: "120", MARK_WAIT_SECONDS: "180" })).toEqual([expect.stringMatching(/^MARK_WAIT_SECONDS=180 must exceed WATERFALL_TICK_SECONDS/)]);
    expect(errs({ WATERFALL_TICK_SECONDS: "120", MARK_WAIT_SECONDS: "300" })).toEqual([]);
  });

  test("mainnetRpcCadence is pure: defaults for the unset keys only", () => {
    const r = mainnetRpcCadence({ MARK_TICK_SECONDS: "60" });
    expect(r.errors).toEqual([]);
    expect(r.env.MARK_TICK_SECONDS).toBeUndefined();
    expect(r.env.INDEXER_POLL_MS).toBe("12000");
  });
});

describe("mainnet log subscriptions: RPC_WS_URL from RHC_RPC_URL / RHC_WS_URL", () => {
  test("Alchemy: wss:// on the same path; another provider needs RHC_WS_URL; off forces polling; bad URLs refused", () => {
    const alchemy = "https://robinhood-mainnet.g.alchemy.com/v2/KEY";
    const env = (e: Env) => mainnetProfile({ ...goodEnv(), ...e }, hostRoot(GOOD_DEP));
    expect(env({ RHC_RPC_URL: alchemy }).env.RPC_WS_URL).toBe("wss://robinhood-mainnet.g.alchemy.com/v2/KEY");
    expect(env({ RHC_RPC_URL: alchemy }).errors).toEqual([]);
    expect(env({}).env.RPC_WS_URL).toBeUndefined(); // Dwellir: no known WebSocket mapping
    expect(env({ RHC_WS_URL: "wss://ws.example.org/KEY" }).env.RPC_WS_URL).toBe("wss://ws.example.org/KEY");
    expect(env({ RHC_RPC_URL: alchemy, RHC_WS_URL: "off" }).env.RPC_WS_URL).toBeUndefined();
    expect(env({ RHC_WS_URL: "ws://ws.example.org/KEY" }).errors).toEqual(["RHC_WS_URL must be a wss:// URL (the provider key travels in it)"]);
    expect(env({ RHC_WS_URL: "wss://127.0.0.1:8546" }).errors).toEqual(["RHC_WS_URL points at a local node"]);
    expect(mainnetWsUrl({ RHC_RPC_URL: alchemy, RHC_WS_URL: " none " })).toBeNull();
    // the subscription knobs are bounded too
    expect(env({ INDEXER_WS_SAFETY_POLL_MS: "5000" }).errors).toEqual([expect.stringMatching(/^INDEXER_WS_SAFETY_POLL_MS=5000 must be within 30000-600000/)]);
    expect(env({ ORACLE_CHAINLINK_EVENT_READ_MS: "3600000" }).errors).toEqual([expect.stringMatching(/^ORACLE_CHAINLINK_EVENT_READ_MS=3600000 must be within 60000-600000/)]);
  });
});
