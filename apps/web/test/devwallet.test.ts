import { describe, expect, test } from "bun:test";
import { DEV_ROLE_INDEX } from "@bookrunner/shared/devkeys";
import { DEVNET_CHAIN_ID, DEV_GROUPS, DEV_WALLETS, devAddress, devEntry, devRoleOf, isDevRole } from "../src/lib/devwallet";

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
