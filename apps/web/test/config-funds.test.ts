import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { CHAIN_PRESETS, DEVNET_CHAIN_ID, LOW_GAS_WEI, RHC_TESTNET_CHAIN_ID, chainLabel, explorerAddress, explorerTx, gasStatus, isTestKind, resolveChainConfig } from "../src/lib/chainConfig";
import { MOCK_MINT_ABI, TEST_USDC_AMOUNT, fmtEth, mintAvailability, mockMintTx, toQuantity } from "../src/lib/funds";

describe("resolveChainConfig", () => {
  test("defaults to the local devnet", () => {
    const c = resolveChainConfig({});
    expect(c).toMatchObject({ id: DEVNET_CHAIN_ID, kind: "devnet", rpcUrl: "http://127.0.0.1:8547", explorerUrl: "", apiUrl: "http://127.0.0.1:4400", usdcAddress: null });
  });
  test("VITE_CHAIN_ID=46630 picks the Robinhood Chain testnet preset", () => {
    const c = resolveChainConfig({ VITE_CHAIN_ID: "46630" });
    expect(c.id).toBe(RHC_TESTNET_CHAIN_ID);
    expect(c.kind).toBe("testnet");
    expect(c.rpcUrl).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(c.explorerUrl).toBe("https://explorer.testnet.chain.robinhood.com");
    expect(c.faucetUrl).toMatch(/^https:\/\//);
  });
  test("env overrides win; trailing slashes are trimmed", () => {
    const c = resolveChainConfig({
      VITE_CHAIN_ID: "46630",
      VITE_RPC_URL: " https://rpc.example/x ",
      VITE_EXPLORER_URL: "https://scan.example/",
      VITE_API_URL: "https://api.example///",
      VITE_USDC_ADDRESS: "0x0000000000000000000000000000000000000001",
    });
    expect(c.rpcUrl).toBe("https://rpc.example/x");
    expect(c.explorerUrl).toBe("https://scan.example");
    expect(c.apiUrl).toBe("https://api.example");
    expect(c.usdcAddress).toBe("0x0000000000000000000000000000000000000001");
  });
  test("test-network features fail closed: only a known devnet or testnet is a test chain", () => {
    expect(isTestKind("devnet")).toBe(true);
    expect(isTestKind("testnet")).toBe(true);
    expect(isTestKind("mainnet")).toBe(false);
    // an unknown id (a real mainnet id that is not the 4663 preset, another chain) is NOT a test network
    const custom = resolveChainConfig({ VITE_CHAIN_ID: "777" });
    expect(custom.kind).toBe("custom");
    expect(isTestKind(custom.kind)).toBe(false);
    // unless the build declares it; a preset keeps its own kind
    expect(resolveChainConfig({ VITE_CHAIN_ID: "777", VITE_CHAIN_KIND: "testnet" }).kind).toBe("testnet");
    expect(resolveChainConfig({ VITE_CHAIN_ID: "777", VITE_CHAIN_KIND: "bogus" }).kind).toBe("custom");
    expect(resolveChainConfig({ VITE_CHAIN_ID: "4663", VITE_CHAIN_KIND: "testnet" }).kind).toBe("mainnet");
  });
  test("mint availability: test networks only, a wallet, the token, and an open mint", () => {
    const ok = { testChain: true, wallet: true, usdc: "0x01", contractsLoading: false, simulated: true };
    expect(mintAvailability(ok)).toBeNull();
    expect(mintAvailability({ ...ok, testChain: false })).toBe("mainnet"); // mainnet or an unknown (custom) chain
    expect(mintAvailability({ ...ok, wallet: false })).toBe("no-wallet");
    expect(mintAvailability({ ...ok, usdc: null })).toBe("no-token");
    expect(mintAvailability({ ...ok, usdc: null, contractsLoading: true })).toBe("checking");
    expect(mintAvailability({ ...ok, simulated: undefined })).toBe("checking");
    expect(mintAvailability({ ...ok, simulated: false })).toBe("not-mintable"); // a real USDC: mint() reverts
  });
  test("unknown ids become a custom chain; bad ids fall back to devnet", () => {
    expect(resolveChainConfig({ VITE_CHAIN_ID: "777", VITE_CHAIN_NAME: "Lab" })).toMatchObject({ id: 777, name: "Lab", kind: "custom" });
    expect(resolveChainConfig({ VITE_CHAIN_ID: "-3" }).id).toBe(DEVNET_CHAIN_ID);
    expect(resolveChainConfig({ VITE_USDC_ADDRESS: "nope" }).usdcAddress).toBeNull();
  });
  test("labels and explorer links", () => {
    const app = CHAIN_PRESETS[RHC_TESTNET_CHAIN_ID];
    expect(chainLabel(46630, app)).toBe("RHC testnet");
    expect(chainLabel(31337)).toBe("Devnet 31337");
    expect(chainLabel(1)).toBe("Chain 1");
    expect(chainLabel(null)).toBe("No chain");
    expect(explorerTx("https://x", "0xab")).toBe("https://x/tx/0xab");
    expect(explorerTx("", "0xab")).toBeNull();
    expect(explorerAddress("https://x", "0xcd")).toBe("https://x/address/0xcd");
  });
});

describe("test funds", () => {
  test("gas status flags an empty or low wallet", () => {
    expect(gasStatus(undefined)).toBe("unknown");
    expect(gasStatus(0n)).toBe("empty");
    expect(gasStatus(LOW_GAS_WEI - 1n)).toBe("low");
    expect(gasStatus(10n ** 18n)).toBe("ok");
  });
  test("mock USDC mint transaction", () => {
    const to = "0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9";
    const t = mockMintTx("0x0000000000000000000000000000000000000abc", to, TEST_USDC_AMOUNT, 46630);
    expect(t.data.startsWith("0x40c10f19")).toBe(true); // mint(address,uint256)
    const d = decodeFunctionData({ abi: MOCK_MINT_ABI, data: t.data });
    expect(d.args).toEqual([to, 10_000_000_000n]);
    expect(t).toMatchObject({ value: "0", chainId: 46630 });
    expect(t.description).toContain("10,000 test USDC");
  });
  test("ETH formatting", () => {
    expect(fmtEth(0n)).toBe("0 ETH");
    expect(fmtEth(10n ** 18n)).toBe("1 ETH");
    expect(fmtEth(1_234_567_000_000_000_000n)).toBe("1.2345 ETH");
    expect(fmtEth(10n ** 12n)).toBe("<0.0001 ETH");
    expect(fmtEth(null)).toBe("—");
    expect(toQuantity(255n)).toBe("0xff");
  });
});
