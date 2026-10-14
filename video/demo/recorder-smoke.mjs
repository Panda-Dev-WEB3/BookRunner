// Recorder smoke test: a ~10 s scenario on the local app (/app/ -> Books page), no wallet, steps logged.
// Output: public/demos/recorder-smoke.webm + recorder-smoke.steps.json (videoOffsetMs / calibrated show the sync result).
// Run: bash scripts/video.sh demo recorder-smoke
import { runScenario } from "./recorder.mjs";

await runScenario({
  name: "recorder-smoke",
  wallet: false,
  run: async ({ page, step, click, scrollTo, wait, expectText }) => {
    step("home");
    await wait(1500);
    await click(page.locator('a[href="/app/books"]:visible').first());
    step("books");
    await expectText("Syndicate desk");
    await wait(1000);
    step("scroll");
    await scrollTo(page.getByText("Marked NAV").first());
    await wait(1500);
  },
});
