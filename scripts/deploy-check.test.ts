import { describe, expect, test } from "bun:test";
import { broadcastSendersProblem, startBlockOf } from "./deploy-check";

describe("deploy-check (deploy-testnet.sh helpers, no host cast / node)", () => {
  test("startBlock = the first receipt's block - 1 (Arbitrum Orbit: block.number is the parent chain's)", () => {
    expect(startBlockOf({ receipts: [{ blockNumber: "0x10" }, { blockNumber: "0x0c" }, {}] })).toBe(11);
    expect(() => startBlockOf({ receipts: [] })).toThrow("no receipts");
  });

  test("senders: every broadcast transaction must come from the checked deployer", () => {
    const tx = (from: string) => ({ transaction: { from } });
    expect(broadcastSendersProblem({ transactions: [tx("0xAbC0000000000000000000000000000000000001"), tx("0xabc0000000000000000000000000000000000001")] }, "0xabc0000000000000000000000000000000000001")).toBeNull();
    expect(broadcastSendersProblem({ transactions: [tx("0xabc0000000000000000000000000000000000001"), tx("0x9990000000000000000000000000000000000009")] }, "0xabc0000000000000000000000000000000000001")).toContain("broadcast signed by 0x9990000000000000000000000000000000000009");
    expect(broadcastSendersProblem({ transactions: [] }, "0xabc0000000000000000000000000000000000001")).toContain("no transaction");
  });
});
