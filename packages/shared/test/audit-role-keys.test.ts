// AUDIT (area 6, off-chain): on testnet every role key, INCLUDING the deployer (= protocol admin /
// timelock, contracts/script/Deploy.s.sol:141,290), derives from the one BKRN_TESTNET_MNEMONIC, and
// scripts/dev.ts:159 hands that mnemonic (plus ANTHROPIC_API_KEY) to EVERY child process: the
// internet-facing API, indexer, receipts, trader-sim, ... A compromise of any one process (or a dependency
// of it) is a full protocol-admin takeover. Secure behaviour asserted here: the admin key is never derived
// from the shared hot mnemonic; it must be supplied explicitly (and only to the process that needs it).
import { describe, expect, test } from "bun:test";
import { english, generateMnemonic } from "viem/accounts";
import { roleAccount } from "../src/devkeys";

describe("audit: role key derivation on testnet", () => {
  const env = { CHAIN_ID: "46630", BKRN_TESTNET_MNEMONIC: generateMnemonic(english) };

  test("the deployer / admin key is not derivable from the hot mnemonic every service receives", () => {
    expect(() => roleAccount("deployer", env)).toThrow();
  });

  test("a hot service key and the admin key never share one secret", () => {
    // whoever holds the mark signer's secret (every service process) must not be able to derive the admin
    const mark = (() => {
      try {
        return roleAccount("markSigner", env).address;
      } catch {
        return null;
      }
    })();
    const admin = (() => {
      try {
        return roleAccount("deployer", env).address;
      } catch {
        return null;
      }
    })();
    expect(mark !== null && admin !== null).toBe(false);
  });
});
