// Phones cannot run wallet browser extensions: with no injected wallet (and no WalletConnect
// project id), the way in is to open the page inside a wallet app's own browser. Pure
// (test/mobile-wallets.test.ts).

/** A phone or tablet browser (user agent, or a touch-only device that hides it). */
export function isMobileBrowser(userAgent: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(userAgent)) return true;
  // iPadOS reports a desktop Safari user agent but has touch points
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export interface WalletAppLink {
  name: string;
  href: string;
}

/** Links that open `pageUrl` in a wallet app's built-in browser. */
export function walletAppLinks(pageUrl: string): WalletAppLink[] {
  const noScheme = pageUrl.replace(/^https?:\/\//, "");
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${noScheme}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(pageUrl)}` },
  ];
}
