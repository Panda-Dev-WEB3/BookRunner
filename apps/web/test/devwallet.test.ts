import { describe, expect, test } from "bun:test";
import { DEV_MNEMONIC, DEV_ROLE_INDEX } from "@bookrunner/shared/devkeys";
import { DEV_MNEMONIC_MARK, filesWithDevKeys, isDevnetBuild } from "../scripts/bundle-check";
import { devAddress, devRoleOf } from "../src/lib/devsigner";
import { DEVNET_CHAIN_ID, DEV_GROUPS, DEV_WALLETS, devEntry, devWalletsAvailable, effectiveMode, isDevRole } from "../src/lib/devwallet";

describe("dev wallets (devnet only)", () => {
  test("every listed role is a real devkeys role in a known group", () => {
    expect(DEVNET_CHAIN_ID).toBe(31337);
    for (const w of DEV_WALLETS) {
      expect(isDevRole(w.role)).toBe(true);
      expect(DEV_GROUPS).toContain(w.group);
    }
    expect(isDevRole("nope")).toBe(false);
    expect(Object.keys(DEV_ROLE_INDEX)).toContain("sponsor");
  });
  test("derives the anvil accounts behind the roles (sponsor = index 7, committee = 8)", () => {
    expect(devAddress("sponsor")).toBe("0x14dC79964da2C08b23698B3D3cc7Ca32193d9955");
    expect(devAddress("committee0")).toBe("0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f");
    expect(devRoleOf("0x14dc79964da2c08b23698b3d3cc7ca32193d9955")).toBe("sponsor");
    expect(devRoleOf("0x0000000000000000000000000000000000000001")).toBeNull();
    expect(devEntry("sponsor")?.label).toBe("Studio sponsor");
  });
});

describe("dev keys never ship outside devnet (scripts/bundle-check.ts, used by vite.config.ts)", () => {
  test("devnet builds are the ones with VITE_CHAIN_ID unset, empty or 31337", () => {
    expect(isDevnetBuild(undefined)).toBe(true);
    expect(isDevnetBuild("")).toBe(true);
    expect(isDevnetBuild("31337")).toBe(true);
    expect(isDevnetBuild("46630")).toBe(false);
    expect(isDevnetBuild("4663")).toBe(false);
  });
  test("finds the anvil mnemonic in output files", () => {
    const files = [
      { file: "assets/index.js", text: "const a = 1;" },
      { file: "assets/devsigner.js", text: `const m = "${DEV_MNEMONIC}";` },
    ];
    expect(filesWithDevKeys(files)).toEqual(["assets/devsigner.js"]);
    expect(DEV_MNEMONIC).toContain(DEV_MNEMONIC_MARK);
  });
});

describe("stored wallet mode", () => {
  test("a stored 'dev' choice only applies while dev wallets are available (shared 127.0.0.1:5180 storage)", () => {
    expect(effectiveMode("dev", true)).toBe("dev");
    expect(effectiveMode("dev", false)).toBeNull(); // testnet build, or an API on another chain: the browser wallet shows
    expect(effectiveMode("injected", false)).toBe("injected");
    expect(effectiveMode(null, true)).toBeNull();
  });
});

describe("dev wallet gate", () => {
  test("devnet build for 31337 and an API on 31337 (unknown counts until /health answers)", () => {
    expect(devWalletsAvailable({ devBuild: true, appChainId: 31337, apiChainId: null })).toBe(true);
    expect(devWalletsAvailable({ devBuild: true, appChainId: 31337, apiChainId: 31337 })).toBe(true);
    // the API reports another chain: no dev wallets, and a stored 'dev' choice falls back to the browser wallet
    expect(devWalletsAvailable({ devBuild: true, appChainId: 31337, apiChainId: 46630 })).toBe(false);
    expect(effectiveMode("dev", devWalletsAvailable({ devBuild: true, appChainId: 31337, apiChainId: 46630 }))).toBeNull();
    // a testnet build never offers them, whatever the API says
    expect(devWalletsAvailable({ devBuild: false, appChainId: 46630, apiChainId: 31337 })).toBe(false);
    expect(devWalletsAvailable({ devBuild: true, appChainId: 46630, apiChainId: null })).toBe(false);
  });
});
