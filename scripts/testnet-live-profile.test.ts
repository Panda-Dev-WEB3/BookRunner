// scripts/dev.ts --network testnet-live: the live-Orderly rehearsal stack next to the public testnet (VERIFY O22).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { english, generateMnemonic } from "viem/accounts";
import { devAccount } from "../packages/shared/src/devkeys";
import {
  TESTNET_LIVE_EXCLUDED,
  TESTNET_LIVE_PINNED,
  TESTNET_ORDERLY,
  TESTNET_LIVE_UNIT_OVERRIDES,
  liveUnitExplicitKeys,
  otherVariant,
  redisHostPort,
  supervisorConflict,
  testnetLiveProfile,
  testnetOrderlyLive,
  variantDeployer,
} from "./network-profile";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const LIVE_DEP = {
  chainId: 46630,
  contracts: { usdc: TESTNET_ORDERLY.usdg, orderlyVault: TESTNET_ORDERLY.vault },
  orderly: { venue: "live", vault: TESTNET_ORDERLY.vault, brokerId: "bookrunner", token: "USDG", settlementToken: TESTNET_ORDERLY.usdg },
  books: [],
};

function root(dep: object | null): string {
  const r = mkdtempSync(join(tmpdir(), "bkrn-testnet-live-"));
  roots.push(r);
  if (dep) {
    mkdirSync(join(r, "contracts/deployments"), { recursive: true });
    writeFileSync(join(r, TESTNET_LIVE_PINNED.DEPLOYMENT_FILE!), JSON.stringify(dep));
  }
  return r;
}

const LIVE_M = generateMnemonic(english);
const PUBLIC_M = generateMnemonic(english);
const env = { BKRN_TESTNET_LIVE_MNEMONIC: LIVE_M, ORDERLY_BUILDER_KEY_SECRET: "seed", ORACLE_SEED: "s", POSTGRES_PASSWORD: "pw", REDIS_PASSWORD: "rp", REDIS_LIVE_PASSWORD: "lp" };
const PUBLIC = { BKRN_TESTNET_MNEMONIC: PUBLIC_M, ORACLE_SEED: "p", OPS_VENUE_PRIVATE_KEY: `0x${"11".repeat(32)}` };
const KEYS = new Set(["BKRN_TESTNET_LIVE_MNEMONIC", "ORDERLY_BUILDER_KEY_SECRET", "ORACLE_SEED"]);

describe("testnet-live profile (separate stack next to the public testnet)", () => {
  test("the public testnet profile never flips to live Orderly (ORDERLY_MODE=live there is refused by dev.ts)", () => {
    expect(testnetOrderlyLive({ ORDERLY_MODE: "live" })).toBe(true);
    expect(testnetOrderlyLive({ ORDERLY_MODE: "mock" })).toBe(false);
  });

  test("defaults: testnet Orderly, USDG, testnet Ledger, manual listing, contract IF; pinned record / DB / Redis db 2 / state / ports; own role mnemonic", () => {
    const r = testnetLiveProfile(env, KEYS, root(LIVE_DEP), [], PUBLIC);
    expect(r.errors).toEqual([]);
    expect(r.env).toMatchObject({
      ORDERLY_MODE: "live",
      ORDERLY_BASE_URL: "https://testnet-api.orderly.org",
      ORDERLY_BROKER_ID: "bookrunner",
      ORDERLY_TOKEN: "USDG",
      ORDERLY_LEDGER_ADDRESS: "0x1826B75e2ef249173FC735149AE4B8e9ea10abff",
      ORDERLY_BUILDER_ACCOUNT_ID: TESTNET_ORDERLY.adminAccountId,
      ORDERLY_LISTING_MODE: "manual",
      ORDERLY_IF_MODE: "contract",
      OPS_FEE_SWEEP_AUTO: "false",
      DEPLOYMENT_FILE: "contracts/deployments/46630.live.json",
      OPS_KEYS_DIR: ".data/testnet-live/keys",
      OPS_SAGA_FILE: ".data/testnet-live/ops-venue/sagas.json",
      DATABASE_URL: "postgres://bookrunner:pw@127.0.0.1:54400/bookrunner_testnet_live",
      REDIS_URL: "redis://:lp@127.0.0.1:63791/0", // its OWN Redis instance (redis-live)
      BKRN_BUS_NS: "testnet-live", // its own bus namespace (channels, keys, queues)
      API_PORT: "4500",
      ORACLE_PORT: "4510",
      CHARTER_PORT: "4530",
      ALERT_API_URL: "http://127.0.0.1:4500",
      ALERT_ORACLE_URL: "http://127.0.0.1:4510",
      BKRN_TESTNET_MNEMONIC: LIVE_M, // the role mnemonic the signing children derive from
    });
    expect([...TESTNET_LIVE_EXCLUDED].sort()).toEqual(["mock-orderly", "trader-sim", "web"]);
    // inter-service URLs follow the live ports when configured
    expect(testnetLiveProfile({ ...env, CHARTER_URL: "http://127.0.0.1:4430", ORACLE_URL: "http://127.0.0.1:4410" }, KEYS, root(LIVE_DEP)).env).toMatchObject({ CHARTER_URL: "http://127.0.0.1:4530", ORACLE_URL: "http://127.0.0.1:4510" });
  });

  test(".env.testnet-live keys override the defaults, never the pinned state / ports", () => {
    const r = testnetLiveProfile(
      { ...env, ORDERLY_IF_MODE: "builder", DEPLOYMENT_FILE: "contracts/deployments/46630.json", OPS_KEYS_DIR: ".data/testnet/keys", API_PORT: "4400" },
      new Set([...KEYS, "ORDERLY_IF_MODE", "DEPLOYMENT_FILE", "OPS_KEYS_DIR", "API_PORT"]),
      root(LIVE_DEP),
    );
    expect(r.errors).toEqual([]);
    expect(r.env).toMatchObject({ ORDERLY_IF_MODE: "builder", DEPLOYMENT_FILE: "contracts/deployments/46630.live.json", OPS_KEYS_DIR: ".data/testnet-live/keys", API_PORT: "4500" });
  });

  test("keys: refuses no live mnemonic, the public stack's mnemonic (same deployer), the anvil mnemonic, an invalid one, a shared explicit key", () => {
    const r0 = root(LIVE_DEP);
    expect(testnetLiveProfile({ ...env, BKRN_TESTNET_LIVE_MNEMONIC: "" }, KEYS, r0).errors).toEqual([expect.stringMatching(/BKRN_TESTNET_LIVE_MNEMONIC is not set/)]);
    const same = testnetLiveProfile({ ...env, BKRN_TESTNET_LIVE_MNEMONIC: PUBLIC_M }, KEYS, r0, [], PUBLIC).errors;
    expect(same).toEqual([expect.stringMatching(/derives the same deployer \(0x[0-9a-fA-F]{40}\) as the public testnet stack/)]);
    expect(same[0]).not.toContain(PUBLIC_M); // never the mnemonic itself
    expect(testnetLiveProfile({ ...env, BKRN_TESTNET_LIVE_MNEMONIC: "test test test test test test test test test test test junk" }, KEYS, r0).errors).toEqual([expect.stringMatching(/public anvil mnemonic/)]);
    expect(testnetLiveProfile({ ...env, BKRN_TESTNET_LIVE_MNEMONIC: "not a mnemonic" }, KEYS, r0).errors).toEqual([expect.stringMatching(/not a valid BIP-39 mnemonic/)]);
    expect(testnetLiveProfile({ ...env, OPS_VENUE_PRIVATE_KEY: PUBLIC.OPS_VENUE_PRIVATE_KEY }, KEYS, r0, [], PUBLIC).errors).toEqual([expect.stringMatching(/OPS_VENUE_PRIVATE_KEY is also a key of the public testnet stack/)]);
    expect(testnetLiveProfile({ ...env, OPS_VENUE_PRIVATE_KEY: `0x${"22".repeat(32)}` }, KEYS, r0, [], PUBLIC).errors).toEqual([]);
  });

  test("refuses: no builder key secret, no oracle seed, fee sweep forced on, a mock-orderly base URL, excluded processes", () => {
    const r = testnetLiveProfile(
      { ...env, ORDERLY_BUILDER_KEY_SECRET: "", ORACLE_SEED: "", OPS_FEE_SWEEP_AUTO: "true", ORDERLY_BASE_URL: "http://127.0.0.1:4420" },
      new Set([...KEYS, "OPS_FEE_SWEEP_AUTO", "ORDERLY_BASE_URL"]),
      root(LIVE_DEP),
      ["mock-orderly", "web"],
    );
    expect(r.errors).toEqual([
      expect.stringMatching(/ORDERLY_BASE_URL must be Orderly's testnet API/),
      expect.stringMatching(/ORDERLY_BUILDER_KEY_SECRET is not set/),
      expect.stringMatching(/ORACLE_SEED is not set/),
      expect.stringMatching(/OPS_FEE_SWEEP_AUTO must stay false/),
      expect.stringMatching(/mock-orderly does not run on the live-Orderly testnet stack/),
      expect.stringMatching(/web does not run on the live-Orderly testnet stack/),
    ]);
  });

  test("refuses a missing record, a mock-venue record and a record on another vault / token / broker", () => {
    expect(testnetLiveProfile(env, KEYS, root(null)).errors).toEqual([expect.stringMatching(/46630\.live\.json not found: deploy the rehearsal stack first/)]);
    const mock = { ...LIVE_DEP, contracts: { usdc: "0x04De000000000000000000000000000000003523", orderlyVault: "0xC488000000000000000000000000000000000eca8" }, orderly: undefined };
    expect(testnetLiveProfile(env, KEYS, root(mock)).errors).toEqual([
      expect.stringMatching(/not a live-venue deployment \(orderly.venue = absent\)/),
      expect.stringMatching(/is not Orderly's testnet vault/),
      expect.stringMatching(/is not testnet USDG/),
    ]);
    const otherBroker = { ...LIVE_DEP, chainId: 31337, orderly: { ...LIVE_DEP.orderly, brokerId: "other" } };
    expect(testnetLiveProfile(env, KEYS, root(otherBroker)).errors).toEqual([expect.stringMatching(/for chain 31337/), expect.stringMatching(/adapters hashed broker other/)]);
  });

  test("supervisor guard: the other variant's fresh status with the same deployer refuses; another deployer, stale or absent does not", () => {
    const me = variantDeployer({ BKRN_TESTNET_MNEMONIC: LIVE_M })!;
    expect(me).toBe(devAccount("deployer", LIVE_M).address);
    expect(variantDeployer({})).toBeNull();
    const now = 1_000_000;
    expect(supervisorConflict({ ts: now - 10_000, network: "testnet", deployer: me.toLowerCase() }, me, now, 90_000)).toMatch(/the testnet stack is running .* with the same deployer/);
    expect(supervisorConflict({ ts: now - 10_000, network: "testnet", deployer: devAccount("deployer", PUBLIC_M).address }, me, now, 90_000)).toBeNull();
    expect(supervisorConflict({ ts: now - 100_000, network: "testnet", deployer: me }, me, now, 90_000)).toBeNull();
    expect(supervisorConflict({ ts: now, network: "testnet" }, me, now, 90_000)).toBeNull(); // an older supervisor without the field
    expect(supervisorConflict(null, me, now, 90_000)).toBeNull();
    expect(otherVariant({ REDIS_PASSWORD: "p", REDIS_LIVE_PASSWORD: "l" }, "testnet-live")).toEqual({ variant: "testnet", redisUrl: "redis://:p@127.0.0.1:63790/1", statusKey: "bkrn:testnet:supervisor:status" });
    expect(otherVariant({}, "testnet")).toEqual({ variant: "testnet-live", redisUrl: "redis://127.0.0.1:63791/0", statusKey: "bkrn:testnet-live:supervisor:status" });
  });

  test("Redis: refuses the public stack's Redis (an override pointing at 63790) and a passwordless live Redis next to a protected infra Redis", () => {
    const r0 = root(LIVE_DEP);
    expect(testnetLiveProfile({ ...env, REDIS_LIVE_URL: "redis://:rp@127.0.0.1:63790/5" }, KEYS, r0).errors).toEqual([expect.stringMatching(/is the public testnet stack's Redis: it needs its own instance/)]);
    expect(testnetLiveProfile({ ...env, REDIS_LIVE_URL: "redis://localhost:63790" }, KEYS, r0).errors).toEqual([expect.stringMatching(/public testnet stack's Redis/)]);
    expect(testnetLiveProfile({ ...env, REDIS_LIVE_URL: "redis://127.0.0.1:6400/0" }, KEYS, r0).errors).toEqual([]);
    const { REDIS_LIVE_PASSWORD: _, ...noLive } = env;
    expect(testnetLiveProfile(noLive, KEYS, r0).errors).toEqual([expect.stringMatching(/REDIS_LIVE_PASSWORD is not set/)]);
    expect(redisHostPort("redis://:x@localhost/1")).toBe("127.0.0.1:6379");
    expect(redisHostPort("nope")).toBeNull();
  });

  test("server unit env (no .env.testnet-live): only the documented override names count as explicit", () => {
    const keys = liveUnitExplicitKeys({ ORDERLY_IF_MODE: "builder", MARK_INTERVAL_SECONDS: "3600", RPC_URL: "http://127.0.0.1:8547", DATABASE_URL: "postgres://x/bookrunner", NETWORK: "devnet", ORDERLY_TOKEN: "" });
    expect([...keys].sort()).toEqual(["MARK_INTERVAL_SECONDS", "ORDERLY_IF_MODE"]);
    expect(TESTNET_LIVE_UNIT_OVERRIDES.has("DATABASE_URL")).toBe(false);
    const r = testnetLiveProfile({ ...env, ORDERLY_IF_MODE: "builder", ORDERLY_LISTING_MODE: "api" }, liveUnitExplicitKeys({ ORDERLY_IF_MODE: "builder" }), root(LIVE_DEP));
    expect(r.env).toMatchObject({ ORDERLY_IF_MODE: "builder", ORDERLY_LISTING_MODE: "manual" });
  });
});

