import { describe, expect, test } from "bun:test";
import { ApiError, decodeResponse, mutationBody, parseHealth, queryUrl, readableMessage } from "../src/dashboard/api";
import { firstAccount, isUnknownChain, parseChainId, safeIcon } from "../src/dashboard/wallet";

describe("tRPC wire format", () => {
  test("query URLs carry the superjson input", () => {
    expect(queryUrl("book.list", undefined)).toBe("/trpc/book.list");
    const u = queryUrl("book.get", { bookId: 1 });
    expect(u.startsWith("/trpc/book.get?input=")).toBe(true);
    expect(JSON.parse(decodeURIComponent(u.split("input=")[1] as string))).toEqual({ json: { bookId: 1 } });
    expect(JSON.parse(mutationBody({ bookId: 1, tranche: "senior" }))).toEqual({ json: { bookId: 1, tranche: "senior" } });
  });

  test("decodes results and errors", () => {
    expect(decodeResponse<number[]>({ result: { data: { json: [1, 2] } } }, 200)).toEqual([1, 2]);
    try {
      decodeResponse({ error: { json: { message: "Deposits are closed", code: -32012, data: { code: "PRECONDITION_FAILED", httpStatus: 412 } } } }, 412);
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("PRECONDITION_FAILED");
      expect((e as ApiError).message).toBe("Deposits are closed");
    }
    expect(() => decodeResponse({}, 500)).toThrow(/Unexpected/);
  });

  test("zod issue lists become readable", () => {
    expect(readableMessage('[{"message":"invalid address"},{"message":"invalid address"}]')).toBe("Invalid address");
    expect(readableMessage("plain")).toBe("plain");
  });

  test("health", () => {
    const h = parseHealth({ ok: true, chainId: 46630, deployment: true, db: "up", redis: "ready", procedures: ["book.list", 3] });
    expect(h).toEqual({ ok: true, chainId: 46630, deployment: true, db: "up", redis: "ready", procedures: ["book.list"] });
    expect(parseHealth({ ok: true }, false).ok).toBe(false);
  });
});

describe("wallet helpers", () => {
  test("chain ids and accounts", () => {
    expect(parseChainId("0xb626")).toBe(46630);
    expect(parseChainId(46630)).toBe(46630);
    expect(parseChainId("46630")).toBe(46630);
    expect(parseChainId("0x0")).toBeNull();
    expect(parseChainId(null)).toBeNull();
    expect(firstAccount(["0xa47b1ae8283c5dcac9f8800e08f81928482ac915"])).toBe("0xa47B1aE8283C5DCAC9f8800e08F81928482AC915");
    expect(firstAccount([])).toBeNull();
    expect(firstAccount("x")).toBeNull();
  });
  test("unknown-chain errors and icons", () => {
    expect(isUnknownChain({ code: 4902 })).toBe(true);
    expect(isUnknownChain({ data: { originalError: { code: 4902 } } })).toBe(true);
    expect(isUnknownChain({ code: 4001 })).toBe(false);
    expect(safeIcon("data:image/svg+xml;base64,AAA")).toBe("data:image/svg+xml;base64,AAA");
    expect(safeIcon("javascript:alert(1)")).toBeNull();
    expect(safeIcon("https://evil.example/x.png")).toBeNull();
  });
});
