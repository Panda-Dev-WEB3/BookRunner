import { describe, expect, test } from "bun:test";
import { maskSecrets } from "../src/logger";

describe("maskSecrets: provider keys never reach a log line", () => {
  test("Alchemy /v2/<key> in a viem error, query keys, plain text untouched", () => {
    const line = '{"err":"HTTP request failed.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv12\nBody"}';
    expect(maskSecrets(line)).toBe('{"err":"HTTP request failed.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/<redacted>\nBody"}');
    expect(maskSecrets("wss://x.example/v3/0123456789abcdef0123 up")).toBe("wss://x.example/v3/<redacted> up");
    expect(maskSecrets('{"url":"https://rpc.x/?apikey=s3cr3t&chain=1"}')).toBe('{"url":"https://rpc.x/?apikey=<redacted>&chain=1"}');
    expect(maskSecrets('{"msg":"mark committed","block":"140083892"}')).toBe('{"msg":"mark committed","block":"140083892"}');
  });
});
