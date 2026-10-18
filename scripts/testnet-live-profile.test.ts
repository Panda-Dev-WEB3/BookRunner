// scripts/dev.ts --network testnet with ORDERLY_MODE=live: the live-Orderly rehearsal variant (VERIFY O22).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TESTNET_LIVE_EXCLUDED, TESTNET_LIVE_PINNED, TESTNET_ORDERLY, testnetLiveProfile, testnetOrderlyLive } from "./network-profile";

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

const env = { ORDERLY_MODE: "live", ORDERLY_BUILDER_KEY_SECRET: "seed", POSTGRES_PASSWORD: "pw", REDIS_PASSWORD: "rp" };

describe("testnet live-Orderly profile", () => {
  test("switch: ORDERLY_MODE=live resolved by the testnet profile; mock stays the default", () => {
    expect(testnetOrderlyLive({ ORDERLY_MODE: "live" })).toBe(true);
    expect(testnetOrderlyLive({ ORDERLY_MODE: "mock" })).toBe(false);
    expect(testnetOrderlyLive({})).toBe(false);
  });

  test("defaults: testnet Orderly hosts, USDG, testnet Ledger, manual listing, contract IF, fee sweep off; own record / DB / Redis / state", () => {
    const r = testnetLiveProfile(env, new Set(["ORDERLY_MODE", "ORDERLY_BUILDER_KEY_SECRET"]), root(LIVE_DEP));
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
      REDIS_URL: "redis://:rp@127.0.0.1:63790/2",
    });
    expect([...TESTNET_LIVE_EXCLUDED].sort()).toEqual(["mock-orderly", "trader-sim"]);
  });

  test(".env.testnet keys override the defaults, never the pinned state", () => {
    const r = testnetLiveProfile(
      { ...env, ORDERLY_IF_MODE: "builder", ORDERLY_LISTING_MODE: "api", DEPLOYMENT_FILE: "contracts/deployments/46630.json", OPS_KEYS_DIR: ".data/testnet/keys" },
      new Set(["ORDERLY_MODE", "ORDERLY_BUILDER_KEY_SECRET", "ORDERLY_IF_MODE", "ORDERLY_LISTING_MODE", "DEPLOYMENT_FILE", "OPS_KEYS_DIR"]),
      root(LIVE_DEP),
    );
    expect(r.errors).toEqual([]);
    expect(r.env).toMatchObject({ ORDERLY_IF_MODE: "builder", ORDERLY_LISTING_MODE: "api", DEPLOYMENT_FILE: "contracts/deployments/46630.live.json", OPS_KEYS_DIR: ".data/testnet-live/keys" });
    // an inherited (not .env.testnet) value does not override a default
    expect(testnetLiveProfile({ ...env, ORDERLY_TOKEN: "USDC" }, new Set(["ORDERLY_MODE"]), root(LIVE_DEP)).env.ORDERLY_TOKEN).toBe("USDG");
  });

  test("refuses: no builder key secret, fee sweep forced on, a mock-orderly base URL, excluded processes", () => {
    const r = testnetLiveProfile(
      { ...env, ORDERLY_BUILDER_KEY_SECRET: "", OPS_FEE_SWEEP_AUTO: "true", ORDERLY_BASE_URL: "http://127.0.0.1:4420" },
      new Set(["ORDERLY_MODE", "OPS_FEE_SWEEP_AUTO", "ORDERLY_BASE_URL"]),
      root(LIVE_DEP),
      ["mock-orderly"],
    );
    expect(r.errors).toEqual([
      expect.stringMatching(/ORDERLY_BASE_URL must be Orderly's testnet API/),
      expect.stringMatching(/ORDERLY_BUILDER_KEY_SECRET is not set/),
      expect.stringMatching(/OPS_FEE_SWEEP_AUTO must stay false/),
      expect.stringMatching(/mock-orderly does not run with ORDERLY_MODE=live/),
    ]);
  });

  test("refuses a missing record, a mock-venue record and a record on another vault / token / broker", () => {
    const keys = new Set(["ORDERLY_MODE"]);
    expect(testnetLiveProfile(env, keys, root(null)).errors).toEqual([expect.stringMatching(/46630\.live\.json not found: deploy the rehearsal stack first/)]);
    const mock = { ...LIVE_DEP, contracts: { usdc: "0x04De000000000000000000000000000000003523", orderlyVault: "0xC488000000000000000000000000000000000eca8" }, orderly: undefined };
    expect(testnetLiveProfile(env, keys, root(mock)).errors).toEqual([
      expect.stringMatching(/not a live-venue deployment \(orderly.venue = absent\)/),
      expect.stringMatching(/is not Orderly's testnet vault/),
      expect.stringMatching(/is not testnet USDG/),
    ]);
    const otherBroker = { ...LIVE_DEP, chainId: 31337, orderly: { ...LIVE_DEP.orderly, brokerId: "other" } };
    expect(testnetLiveProfile(env, keys, root(otherBroker)).errors).toEqual([expect.stringMatching(/for chain 31337/), expect.stringMatching(/adapters hashed broker other/)]);
  });
});
