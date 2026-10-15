// Clip 1, the public site (https://bookrunner.tech; no local server, no wallet): home hero -> scroll through how the
// book works -> /dashboard/ (books table, desk activity) -> /status/ -> /documents/ (the rulebook, scrolled).
import { BEAT, LONG_REST, REST, visible, visibleText, wheelScroll } from "./common.mjs";

const SITE = "https://bookrunner.tech";

export const scenario = {
  id: "site",
  name: "1-site",
  baseUrl: `${SITE}/`,
  wallet: false,
  steps: ["hero", "ecosystem", "fee-flow", "dashboard", "books", "desk-activity", "status", "rulebook", "tranches", "waterfall", "loss-order", "mandate", "marks"],
  async run(ctx) {
    const { page, step, scrollTo, wait, waitFor } = ctx;
    const heading = (text) => visible(page, `h1:has-text(${JSON.stringify(text)}), h2:has-text(${JSON.stringify(text)})`);

    await waitFor(heading("Run the book."), { timeout: 30_000 });
    step("hero");
    await wait(LONG_REST);

    await scrollTo(heading("Meet the BookRunner."));
    step("ecosystem");
    await wait(REST);
    await wheelScroll(ctx, 900);
    await wait(REST);

    await scrollTo(heading("Connecting capital with the market’s fee flow"));
    step("fee-flow");
    await wait(REST);
    await wheelScroll(ctx, 1100);
    await wait(REST);

    await page.goto(`${SITE}/dashboard/`, { waitUntil: "load", timeout: 45_000 });
    await waitFor(visibleText(page, "The book desk"), { timeout: 30_000 });
    step("dashboard");
    await wait(REST);

    await scrollTo(visibleText(page, "The market books"));
    await waitFor(visibleText(page, "PERP_NVDA_USDC"), { timeout: 30_000 });
    step("books");
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "Desk activity"));
    await waitFor(visibleText(page, "Mark committed"), { timeout: 30_000 });
    step("desk-activity");
    await wait(LONG_REST);

    await page.goto(`${SITE}/status/`, { waitUntil: "load", timeout: 45_000 });
    await waitFor(visibleText(page, "Machine-readable"), { timeout: 30_000 });
    step("status");
    await wait(LONG_REST);

    await page.goto(`${SITE}/documents/`, { waitUntil: "load", timeout: 45_000 });
    await waitFor(visibleText(page, "Its rules, in full."), { timeout: 30_000 });
    step("rulebook");
    await wait(REST);

    await scrollTo(visibleText(page, "One market book."));
    step("tranches");
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "The flow has an order."));
    step("waterfall");
    await wait(LONG_REST);

    await ctx.click(page.getByRole("tab", { name: "Loss order" }).filter({ visible: true }).first());
    await waitFor(visibleText(page, "Junior absorbs loss"));
    step("loss-order");
    await wait(LONG_REST);

    await scrollTo(visibleText(page, "The mandate sets the boundary."));
    step("mandate");
    await wait(REST);
    await wheelScroll(ctx, 500);
    await wait(BEAT);

    await scrollTo(visibleText(page, "Every mark leaves a record."));
    step("marks");
    await wait(REST);
    await wheelScroll(ctx, 500);
    await wait(REST);
  },
};
