// Records the live testnet pages for scene 8. Run: bash scripts/video.sh footage
// Read-only: page loads and a scroll, nothing is clicked. Each clip is trimmed so it opens on the rendered page
// (the dashboard's load is slow and would otherwise open on a blank page) and cut to `ms`.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

const OUT = "/work/public/footage";
mkdirSync(OUT, { recursive: true });
/**
 * `scroll`: px scrolled (eased) between `scrollAt` and `scrollAt + 4 s` of the clip. The dashboard is 2054 px tall at
 * 1920x1080; 720 px brings the stat cards, the market-books table and the desk activity (signed marks) into view.
 * `zoom`: browser zoom; the status page is one narrow table, so it is shown at 150%.
 */
const shots = [
  { name: "dashboard", url: "https://bookrunner.tech/dashboard/", ms: 14000, scroll: 720, scrollAt: 2000, zoom: 1 },
  { name: "status", url: "https://bookrunner.tech/status/", ms: 9000, scroll: 0, scrollAt: 0, zoom: 1.5 },
];
/** Playwright's own ffmpeg build (webm demux, VP9 encode) does the trim. */
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright";
const ffdir = readdirSync(BROWSERS).find((d) => d.startsWith("ffmpeg-"));
if (!ffdir) throw new Error(`no ffmpeg under ${BROWSERS}`);
const FFMPEG = `${BROWSERS}/${ffdir}/ffmpeg-linux`;

const browser = await chromium.launch();
for (const s of shots) {
  const dir = `${OUT}/.tmp-${s.name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(s.url, { waitUntil: "networkidle", timeout: 45000 });
  } catch (e) {
    // The dashboard polls live data; if the network never goes idle, take the load event plus a fixed wait.
    console.log(`${s.name}: networkidle did not settle (${String(e).split("\n")[0]}); using load + 4 s`);
    await page.waitForLoadState("load");
    await page.waitForTimeout(4000);
  }
  await page.evaluate(() => document.fonts.ready);
  if (s.zoom !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, s.zoom);
  await page.waitForTimeout(600); // let late layout and images settle before the clip opens
  const start = Date.now() - t0;
  console.log(`${s.name}: ready after ${start} ms`);
  if (s.scroll) {
    await page.waitForTimeout(s.scrollAt);
    await page.evaluate(async (y) => {
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const d = 4000;
      const a = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min(1, (now - a) / d);
          window.scrollTo(0, y * ease(t));
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    }, s.scroll);
  }
  await page.waitForTimeout(s.ms - (Date.now() - t0 - start) + 500);
  const raw = await page.video().path();
  await ctx.close();
  const out = `${OUT}/${s.name}.webm`;
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error",
    "-ss", (start / 1000).toFixed(3), "-i", raw, "-t", (s.ms / 1000).toFixed(3),
    "-an", "-c:v", "libvpx-vp9", "-b:v", "4M", "-deadline", "good", "-cpu-used", "4", "-r", "30",
    out,
  ], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  console.log(`${s.name}: ${out} ${(statSync(out).size / 1e6).toFixed(1)} MB`);
}
await browser.close();
