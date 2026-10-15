// Shared helpers for the demo scenarios (scenarios/*.mjs). Pure page-driving code on the recorder's ctx: no
// Playwright import, so the scenario modules (and their exported step keys) load in bun tests too.

/** Pacing (ms): a screen the viewer should read rests REST; a short beat between actions is BEAT. */
export const REST = 2800;
export const LONG_REST = 3600;
export const BEAT = 1200;

/** Header text of the app's account button once the demo wallet is connected (0x10e1…ed33 style). */
export const shortHex = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** First visible element matching `selector` (Framer and the app render hidden responsive duplicates). */
export const visible = (page, selector) => page.locator(selector).filter({ visible: true }).first();

/** First visible element whose text contains `text`. */
export const visibleText = (page, text, opts = {}) => page.getByText(text, opts).filter({ visible: true }).first();

/** An in-app link by its href under the /app/ base (e.g. "books/1"), first visible one. */
export const appLink = (page, path) => visible(page, `a[href="/app/${path}"]`);

/** Opens an operator page through the header's "Protocol" menu (e.g. path "agents"), as a visitor would. */
export async function viaProtocolMenu(ctx, path) {
  const nav = ctx.page.getByRole("navigation", { name: "Primary" });
  await ctx.click(nav.getByRole("button", { name: "Protocol" }));
  await ctx.wait(700);
  await ctx.click(nav.locator(`a[href="/app/${path}"]`));
}

/**
 * Connects the demo wallet through the app's own Connect wallet dialog and waits until the header shows its address.
 * Connecting shares the address only: no signature, no transaction.
 */
export async function connectDemoWallet(ctx) {
  const { page, click, waitFor, wallet } = ctx;
  if (!wallet) throw new Error("connectDemoWallet: the scenario must run with wallet: true");
  await click(page.getByRole("button", { name: /^connect( wallet)?$/i }).filter({ visible: true }).first());
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await waitFor(dialog);
  await ctx.wait(BEAT);
  await click(dialog.getByRole("button", { name: /Demo wallet/ }));
  await waitFor(page.getByRole("button", { name: `Wallet ${shortHex(wallet.address)}. Open account menu` }).first(), { timeout: 30_000 });
}

/**
 * Scrolls the window by `px` (negative: up) at about `pxPerSec`, eased, frame by frame in the page, so scroll-driven
 * page animations play as they would for a reader. (Per-tick mouse.wheel calls are far too slow on heavy pages.)
 */
export async function wheelScroll(ctx, px, { pxPerSec = 600 } = {}) {
  const ms = Math.max(400, Math.round((Math.abs(px) / pxPerSec) * 1000));
  await ctx.page.evaluate(
    ({ px, ms }) =>
      new Promise((done) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const frame = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
          window.scrollTo(0, start + px * e);
          if (k < 1) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      }),
    { px, ms },
  );
  await ctx.wait(400);
}

/** Asserts that no transaction was sent from the demo wallet (scenarios that must never sign). */
export function assertNoTx(ctx, where) {
  const n = ctx.wallet?.txs.length ?? 0;
  if (n !== 0) throw new Error(`${where}: ${n} transaction(s) were sent; this scenario must never sign`);
}
