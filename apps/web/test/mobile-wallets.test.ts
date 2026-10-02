// Phones with no injected wallet are sent to a wallet app's built-in browser (lib/mobileWallets.ts).
import { describe, expect, test } from "bun:test";
import { isMobileBrowser, walletAppLinks } from "../src/lib/mobileWallets";

describe("mobile wallets", () => {
  test("detects phone and tablet browsers, including iPadOS's desktop user agent", () => {
    expect(isMobileBrowser("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36")).toBe(true);
    expect(isMobileBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe(true);
    expect(isMobileBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", 5)).toBe(true);
    expect(isMobileBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", 0)).toBe(false);
    expect(isMobileBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36")).toBe(false);
  });
  test("deep links open the current page in a wallet app's browser", () => {
    const links = walletAppLinks("https://bookrunner.example/books/1?tranche=junior#invest");
    expect(links.map((l) => l.name)).toEqual(["MetaMask", "Coinbase Wallet"]);
    expect(links[0]?.href).toBe("https://metamask.app.link/dapp/bookrunner.example/books/1?tranche=junior#invest");
    expect(links[1]?.href).toBe(`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent("https://bookrunner.example/books/1?tranche=junior#invest")}`);
  });
});
