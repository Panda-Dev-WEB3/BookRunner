// Clip 4, risk and proof (local app, no wallet): Risk monitor -> Agents (desk keys per book, read only) -> NVDA book:
// live limits -> signed marks -> Verify proof (receipts root rebuilt in the browser, one receipt's inclusion proof) ->
// fee-flow waterfall -> loss order illustration (the slider is a local what-if, nothing is sent).
// Nothing is signed or sent; register / revoke on the Agents page are never touched.
import { BEAT, LONG_REST, REST, appLink, viaProtocolMenu, visibleText } from "./common.mjs";

export const scenario = {
  id: "risk",
  name: "4-risk",
  path: "risk",
  wallet: false,
  steps: ["risk", "kill-log", "agents", "agent-books", "book", "limits", "marks", "verify-mark", "verify-receipt", "waterfall", "loss-junior", "loss-senior"],
  async run(ctx) {
    const { page, step, click, drag, scrollTo, wait, expectText, waitFor } = ctx;

    await expectText("Limit states");
    await expectText("Within limits");
    step("risk");
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "Kill log"));
    await expectText("Breach and kill events");
    step("kill-log");
    await wait(REST);

    await viaProtocolMenu(ctx, "agents");
    await expectText("Desk keys");
    await expectText("Agent heartbeat");
    step("agents");
    await wait(LONG_REST);

    // Each book has its own desk keys (read only: the register / revoke controls are never touched).
    for (const name of ["TSLA #2", "RHX5 #3"]) {
      await click(page.getByRole("radio", { name }));
      await expectText("Agent heartbeat");
      if (name === "TSLA #2") step("agent-books");
      await wait(REST);
    }

    await viaProtocolMenu(ctx, "books");
    await expectText("All books");
    await click(appLink(page, "books/1"));
    await expectText("Invest in NVDA");
    step("book");
    await wait(REST);

    await scrollTo(visibleText(page, "Inventory, hedge & limits"));
    await expectText("risk monitor");
    step("limits");
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "signed EIP-712, committed on-chain"));
    // The marks table scrolls sideways at this width: bring the newest row's button into view.
    const verify = page.getByRole("button", { name: "Verify proof", exact: true }).first();
    await waitFor(verify, { timeout: 30_000 });
    step("marks");
    await wait(REST);
    await scrollTo(verify);
    await wait(BEAT);

    await click(verify);
    await expectText("Matches the root signed into mark #", { timeout: 60_000 });
    await expectText("Matches MarkCommitted on-chain", { timeout: 60_000 });
    await scrollTo(visibleText(page, "computed locally, OpenZeppelin StandardMerkleTree"));
    step("verify-mark");
    await wait(LONG_REST);

    // A receipt from the panel's own list (newest first; a fill when one is listed, else a quote): its inclusion
    // proofs are checked in the browser.
    const receipts = page.locator("#verify").getByRole("button", { name: /^#\d+ (fill|quote)$/ });
    await waitFor(receipts.first());
    const fill = page.locator("#verify").getByRole("button", { name: /^#\d+ fill$/ });
    await click((await fill.count()) ? fill.first() : receipts.first());
    await expectText("Verified in the browser", { timeout: 60_000 });
    step("verify-receipt");
    await wait(BEAT);
    await scrollTo(visibleText(page, "Included in hourly root"));
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "Fee-flow waterfall"));
    await expectText("Conserved: every unit is accounted for.");
    step("waterfall");
    await wait(LONG_REST);

    // Loss order: an illustration computed in the browser on the last marked tranche NAVs.
    const slider = page.locator("#loss-slider");
    await scrollTo(slider);
    await drag(slider, 0.01, 0.3);
    step("loss-junior");
    await wait(LONG_REST);
    await drag(slider, 0.3, 0.68);
    step("loss-senior");
    await wait(LONG_REST);
  },
};
