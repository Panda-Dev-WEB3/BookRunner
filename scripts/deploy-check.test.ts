import { describe, expect, test } from "bun:test";
import { startBlockOf } from "./deploy-check";

describe("deploy-check (deploy-testnet.sh helpers, no host cast / node)", () => {
  test("startBlock = the first receipt's block - 1 (Arbitrum Orbit: block.number is the parent chain's)", () => {
    expect(startBlockOf({ receipts: [{ blockNumber: "0x10" }, { blockNumber: "0x0c" }, {}] })).toBe(11);
    expect(() => startBlockOf({ receipts: [] })).toThrow("no receipts");
  });
});
