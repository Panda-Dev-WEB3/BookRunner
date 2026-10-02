// Revert reasons in plain words (lib/revert.ts) and their use in the tx flow's error line.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { encodeErrorResult, parseAbi, toFunctionSelector } from "viem";
import { REVERT_ABI, findRevertData, revertMessage, revertReason } from "../src/lib/revert";
import { errText } from "../src/lib/txflow";

const A = "0x2222222222222222222222222222222222222222";
const enc = (errorName: string, args: readonly unknown[] = []) => encodeErrorResult({ abi: REVERT_ABI, errorName: errorName as never, args: args as never });

describe("findRevertData", () => {
  test("finds the payload anywhere in the cause / data chain", () => {
    const data = enc("DepositsClosed");
    expect(findRevertData({ data })).toBe(data);
    // viem CallExecutionError -> RpcRequestError with the RPC's {code: 3, data}
    expect(findRevertData({ shortMessage: "Execution reverted", cause: { cause: { code: 3, message: "execution reverted", data } } })).toBe(data);
    // MetaMask: {code: -32603, data: {originalError: {data}}}
    expect(findRevertData({ code: -32603, data: { originalError: { code: 3, data } } })).toBe(data);
    expect(findRevertData(new Error("boom"))).toBeNull();
    expect(findRevertData(null)).toBeNull();
  });
});

describe("revertReason", () => {
  test("the testnet's eth_estimateGas answer for a deposit with no allowance (0xfb8f41b2)", () => {
    const data = enc("ERC20InsufficientAllowance", [A, 0n, 1_000_000_000n]);
    expect(data.slice(0, 10)).toBe("0xfb8f41b2");
    expect(revertReason({ code: 3, message: "execution reverted", data })).toBe("The token allowance is too low for this amount. Run the approval step first, then this one.");
  });

  test("a claim against an empty escrow (InsufficientLiquidity, needed 400159336, available 0)", () => {
    const data = enc("InsufficientLiquidity", [400_159_336n, 0n]);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("InsufficientLiquidity(uint256,uint256)"));
    const why = revertReason({ cause: { data } });
    expect(why).toContain("400.15 USDC needed, 0.00 USDC available");
    expect(why).toContain("Collecting waits until the keeper brings it back");
  });

  test("other errors the investor flows can hit", () => {
    expect(revertReason({ data: enc("DepositsClosed") })).toContain("Deposits into this tranche are closed");
    expect(revertReason({ data: enc("WalletCapExceeded", [250_000_000_000n, 300_000_000_000n]) })).toContain("250,000.00 USDC");
    expect(revertReason({ data: enc("CooldownActive", [1_793_552_400n]) })).toContain("The unstake cooldown is still running, until");
    expect(revertReason({ data: enc("NotAuthorized") })).toContain("not allowed to act for that account");
    const reasonString = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["paused"] });
    expect(revertReason({ data: reasonString })).toBe("The transaction would fail on-chain: paused.");
    expect(revertReason({ data: "0xdeadbeef" })).toBe("The transaction would fail on-chain (error 0xdeadbeef).");
    expect(revertReason(new Error("no data"))).toBeNull();
  });

  test("every message passes the copy rules", () => {
    for (const item of REVERT_ABI) {
      if (item.type !== "error") continue;
      const args = item.inputs.map((i) => (i.type === "address" ? A : 1_000_000n));
      expect(checkCopy(revertMessage(item.name, args) ?? "")).toEqual([]);
    }
  });
});

describe("errText", () => {
  test("prefers the decoded reason over viem's first line", () => {
    const data = enc("DepositsClosed");
    expect(errText({ shortMessage: "Execution reverted with reason: custom error 0x...", cause: { data } })).toContain("Deposits into this tranche are closed");
    expect(errText({ shortMessage: "HTTP request failed.\nStatus: 429" })).toBe("HTTP request failed.");
  });
});
