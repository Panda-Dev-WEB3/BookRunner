// Clip 2, an allocator deposits (local app + demo wallet; the ONLY clip that sends transactions, all on testnet
// 46630): connect "Demo wallet" -> account menu "Mint 10,000 test USDC" (tx 1) -> Books -> NVDA: NAV, fee-flow
// waterfall, fills & hedges, signed marks -> Invest: Junior, 1,000 test USDC -> review shows the prepared approve +
// deposit -> "Sign and send 2 transactions" (tx 2, 3) -> both receipts -> Portfolio: the deposit waits in escrow for
// a mark -> the Withdraw tab, shown only (nothing sent). Every receipt must be `success`.
import { BEAT, LONG_REST, REST, appLink, connectDemoWallet, shortHex, viaProtocolMenu, visibleText } from "./common.mjs";

export const DEPOSIT_USDC = "1000";
const TX_TIMEOUT_MS = 180_000;

/** Waits for every transaction the demo wallet sent to have a receipt; throws unless all are `success`. */
async function assertReceipts(ctx, expected, where) {
  const txs = await ctx.wallet.settled();
  for (const t of txs) console.log(`[2-allocator] tx ${t.hash} ${t.status}`);
  if (txs.length !== expected) throw new Error(`${where}: expected ${expected} transaction(s), the wallet sent ${txs.length}`);
  const bad = txs.filter((t) => t.status !== "success");
  if (bad.length) throw new Error(`${where}: receipt not success: ${bad.map((t) => `${t.hash} ${t.status}`).join(", ")}`);
}

export const scenario = {
  id: "allocator",
  name: "2-allocator",
  path: "",
  wallet: true,
  timeoutMs: 15 * 60_000,
  steps: ["home", "connect", "balances", "mint", "minted", "books", "book", "nav", "waterfall", "fills", "marks", "tranche", "amount", "review", "sign", "confirmed", "portfolio", "pending", "withdraw"],
  async run(ctx) {
    const { page, step, click, type, scrollTo, wait, expectText, waitFor, wallet } = ctx;

    await expectText("Be the house for one perp market.", { timeout: 30_000 });
    step("home");
    await wait(REST);

    await connectDemoWallet(ctx);
    step("connect");
    await wait(BEAT);

    const account = page.getByRole("button", { name: `Wallet ${shortHex(wallet.address)}. Open account menu` }).first();
    await click(account);
    const menu = page.getByRole("dialog", { name: "Account" });
    await waitFor(menu);
    await waitFor(menu.getByText("Robinhood Chain Testnet").first());
    step("balances");
    await wait(REST);

    // tx 1: MockERC20.mint(self, 10,000 test USDC), sent from the account menu.
    const mint = menu.getByRole("button", { name: /^Mint 10,000 test / });
    await click(mint, { timeout: 30_000 }); // enabled once the mint simulation and gas balance are read
    step("mint");
    await waitFor(menu.getByRole("button", { name: /^Minted\. Mint 10,000 more test / }), { timeout: TX_TIMEOUT_MS });
    await assertReceipts(ctx, 1, "mint");
    await wait(BEAT); // the balances refresh after the receipt
    step("minted");
    await wait(REST);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden", timeout: 3000 }).catch(() => click(account));
    await menu.waitFor({ state: "hidden" });

    await viaProtocolMenu(ctx, "books");
    await expectText("All books");
    step("books");
    await wait(REST);

    await click(appLink(page, "books/1"));
    await expectText("Invest in NVDA");
    step("book");
    await wait(REST);

    await scrollTo(visibleText(page, "Senior NAV (base layer)"));
    step("nav");
    await wait(REST);

    await scrollTo(visibleText(page, "Fee-flow waterfall"));
    await expectText("Conserved: every unit is accounted for.");
    step("waterfall");
    await wait(REST);

    await scrollTo(visibleText(page, "Fills & hedges"));
    step("fills");
    await wait(REST);

    await scrollTo(visibleText(page, "signed EIP-712, committed on-chain"));
    step("marks");
    await wait(REST);

    // Invest panel at the top of the book page: Junior, then the amount.
    const invest = page.getByRole("region", { name: "Invest in NVDA" });
    await click(invest.getByRole("button", { name: "Choose Junior" }));
    await waitFor(invest.getByRole("button", { name: "Junior selected" }));
    step("tranche");
    await wait(BEAT);
    await click(invest.getByRole("button", { name: "Continue with Junior" }));

    const amount = page.locator("#deposit-1");
    await waitFor(amount);
    await expectText("Wallet balance");
    await type(amount, DEPOSIT_USDC);
    const review = invest.getByRole("button", { name: "Review deposit" });
    await waitFor(review);
    step("amount");
    await wait(REST);

    // tranche.subscribe prepares approve + deposit; nothing is sent until the sign button.
    await click(review, { timeout: 30_000 });
    await expectText("You deposit");
    const sign = invest.getByRole("button", { name: "Sign and send 2 transactions" });
    await waitFor(sign, { timeout: 60_000 });
    step("review");
    await wait(LONG_REST);

    // tx 2, 3: USDC approve, then the Junior tranche deposit.
    await click(sign, { timeout: 30_000 });
    step("sign");
    await expectText("Deposit confirmed", { timeout: TX_TIMEOUT_MS });
    await assertReceipts(ctx, 3, "deposit");
    step("confirmed");
    await wait(LONG_REST);

    await click(invest.getByRole("link", { name: "Open your portfolio" }));
    await expectText("Your portfolio");
    await expectText("In escrow until a mark accepts them", { timeout: 120_000 });
    step("portfolio");
    await wait(REST);

    await scrollTo(visibleText(page, "Pending deposit", { exact: true }));
    step("pending");
    await wait(REST);

    // Withdraw tab: shown only; nothing is requested or sent.
    await page.goto(new URL("books/1?tab=withdraw", ctx.baseUrl).href, { waitUntil: "load", timeout: 45_000 });
    await waitFor(page.getByRole("tab", { name: /Withdraw/, selected: true }), { timeout: 30_000 });
    await waitFor(page.getByRole("region", { name: "Your position" }), { timeout: 60_000 });
    step("withdraw");
    await wait(LONG_REST);
    await assertReceipts(ctx, 3, "end");
  },
};
