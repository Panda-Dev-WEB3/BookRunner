// Recorder smoke test: a ~10 s scenario on the local app (/app/ -> Books page), no wallet, three steps logged.
// Output: public/demos/recorder-smoke.webm + recorder-smoke.steps.json. Check the cursor with a frame grab (video/README.md).
// Run: bash scripts/video.sh demo recorder-smoke
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordScenario } from "./recorder.mjs";
import { startAppServer } from "./serve-app.mjs";

const VIDEO = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const DIST = process.env.APP_DIST ?? join(VIDEO, "../apps/web/dist");
const server = await startAppServer({ distDir: DIST, port: Number(process.env.DEMO_PORT ?? 4611) });
try {
  const res = await recordScenario({
    name: "recorder-smoke",
    baseUrl: server.url,
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
  console.log(`recorded ${res.webm}`);
  console.log(JSON.stringify(res.steps));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await server.close();
}
