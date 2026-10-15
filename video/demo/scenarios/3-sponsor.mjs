// Clip 3, a sponsor files a charter (local app + demo wallet connected; nothing is ever signed): Charters ->
// File a charter with an example AAPL market through the five steps -> "Validate and prepare filing" lists the
// prepared transactions -> STOP (the sign button is never clicked) -> charter #1 (terms, jury verdict, committee
// votes) -> Committee recent decisions -> book #1, the book that charter became.
// The form draft lives in localStorage; every recording uses a fresh browser context, so the form starts from the
// app's example values.
import { BEAT, LONG_REST, REST, appLink, assertNoTx, connectDemoWallet, viaProtocolMenu, visibleText } from "./common.mjs";

export const scenario = {
  id: "sponsor",
  name: "3-sponsor",
  path: "charters",
  wallet: true,
  steps: ["charters", "connect", "form", "market", "capital", "mandate", "tranches", "review", "prepared", "charter", "jury", "votes", "committee", "book"],
  async run(ctx) {
    const { page, step, click, type, scrollTo, wait, expectText, waitFor } = ctx;
    const next = async (label) => {
      await click(page.getByRole("button", { name: `Next: ${label}` }));
      await waitFor(page.locator('[aria-current="step"]', { hasText: label }));
    };

    await waitFor(appLink(page, "charters/1"), { timeout: 30_000 });
    step("charters");
    await wait(REST);

    await connectDemoWallet(ctx);
    step("connect");
    await wait(BEAT);

    await click(appLink(page, "charters/new"));
    await expectText("File a charter");
    await expectText("Propose a perp market");
    step("form");
    await wait(REST);

    // 1 Market: an example AAPL Stock Token perp listed on the Orderly-style venue.
    await type(page.locator("#f-name"), "AAPL perp book");
    await type(page.locator("#f-underlying"), "AAPL");
    await click(page.getByRole("button", { name: "Suggest" }));
    await page.waitForFunction(() => document.querySelector("#f-symbol")?.value === "PERP_AAPL_USDC", null, { timeout: 10_000 });
    step("market");
    await wait(REST);

    // 2 Capital: insurance fund and market-making inventory.
    await next("Capital");
    await type(page.locator("#f-if"), "40000");
    await type(page.locator("#f-mm"), "100000");
    await expectText("$140,000");
    step("capital");
    await wait(REST);

    // 3 Mandate: limits the agents work under; the hedge allow-list holds the underlying.
    await next("Mandate");
    await type(page.locator("#m-inv"), "60000");
    await type(page.getByRole("textbox", { name: "Hedge asset 1" }), "AAPL");
    await scrollTo(visibleText(page, "No new risk outside the session"));
    step("mandate");
    await wait(REST);

    // 4 Tranche terms: the example values (Senior cap 70%, Senior share 60%, 10 min window, 15 min Junior notice).
    await next("Tranche terms");
    await expectText("Senior cap (bps of book capital)");
    step("tranches");
    await wait(REST);

    // 5 Review, then validate: charter.file only prepares the filing (approve, stake, file); nothing is sent.
    await next("Review");
    await expectText("PERP_AAPL_USDC");
    step("review");
    await wait(REST);

    await click(page.getByRole("button", { name: "Validate and prepare filing" }));
    await expectText("Valid charter", { timeout: 60_000 });
    const sign = page.getByRole("button", { name: /^Sign and send/ });
    await waitFor(sign, { timeout: 30_000 });
    await scrollTo(sign);
    step("prepared");
    await wait(LONG_REST + BEAT);
    assertNoTx(ctx, "3-sponsor after prepare"); // stop here: the filing is never signed

    await viaProtocolMenu(ctx, "charters");
    await click(appLink(page, "charters/1"));
    await expectText("Jury verdict");
    step("charter");
    await wait(REST);

    await scrollTo(visibleText(page, "Jury verdict"));
    step("jury");
    await wait(REST);

    await scrollTo(visibleText(page, "2 of 3 bonded members"));
    await expectText("Tally source: RiskCommittee on-chain");
    step("votes");
    await wait(REST);

    await viaProtocolMenu(ctx, "committee");
    await expectText("Recent decisions");
    step("committee");
    await wait(LONG_REST);

    await click(appLink(page, "books/1"));
    await expectText("Invest in NVDA");
    step("book");
    await wait(REST);
    assertNoTx(ctx, "3-sponsor");
  },
};
