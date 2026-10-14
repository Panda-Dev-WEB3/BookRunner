// Records the live testnet pages for scene 8. Run: bash scripts/video.sh footage
// Read-only: page loads and a scroll, nothing is clicked. Each clip is trimmed so it opens on the rendered page
// (the dashboard's load is slow and would otherwise open on a blank page) and cut to `ms`.
// Fails loudly (non-zero exit, existing clips untouched) on a navigation error, a non-2xx response, a page missing
// its landmark text, or an output under 200 KB. New clips replace the old ones only once every clip has succeeded.
import { chromium, errors } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";

const OUT = "/work/public/footage";
const MIN_BYTES = 200_000;
/**
 * `scroll`: px scrolled (eased) between `scrollAt` and `scrollAt + 4 s` of the clip. The dashboard is 2054 px tall at
 * 1920x1080; 720 px brings the stat cards, the market-books table and the desk activity (signed marks) into view.
 * `zoom`: browser zoom; the status page is one narrow table, so it is shown at 150%.
 * `landmarks`: visible text that must be on the page before recording (the books table / the all-clear banner, and
 * the three tickers). A degraded status page fails here rather than ending up in the video.
 */
const shots = [
  {
    name: "dashboard", url: "https://bookrunner.tech/dashboard/", ms: 14000, scroll: 720, scrollAt: 2000, zoom: 1,
    landmarks: ["The market books", "NVDA", "TSLA", "RHX5"],
  },
  {
    name: "status", url: "https://bookrunner.tech/status/", ms: 9000, scroll: 0, scrollAt: 0, zoom: 1.5,
    landmarks: ["All books operating normally", "NVDA", "TSLA", "RHX5"],
  },
];
/** Playwright's own ffmpeg build (webm demux, VP9 encode) does the trim. */
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright";
const ffdir = readdirSync(BROWSERS).find((d) => d.startsWith("ffmpeg-"));
if (!ffdir) throw new Error(`no ffmpeg under ${BROWSERS}`);
const FFMPEG = `${BROWSERS}/${ffdir}/ffmpeg-linux`;

const tmpDir = (s) => `${OUT}/.tmp-${s.name}`;
const tmpClip = (s) => `${tmpDir(s)}/clip.webm`;

/** Records one page into `tmpClip(s)`; throws on any failure. */
async function record(browser, s) {
  const dir = tmpDir(s);
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  let raw;
  let start;
  try {
    const page = await ctx.newPage();
    const t0 = Date.now();
    // Navigation errors (DNS, refused, ERR_*) propagate; only the network-idle wait may time out.
    const res = await page.goto(s.url, { waitUntil: "load", timeout: 45000 });
    if (!res) throw new Error(`${s.name}: no response for ${s.url}`);
    if (!res.ok()) throw new Error(`${s.name}: HTTP ${res.status()} for ${s.url}`);
    try {
      await page.waitForLoadState("networkidle", { timeout: 45000 });
    } catch (e) {
      if (!(e instanceof errors.TimeoutError)) throw e;
      // The dashboard polls live data; if the network never goes idle, take the load event plus a fixed wait.
      console.log(`${s.name}: networkidle did not settle; using load + 4 s`);
      await page.waitForTimeout(4000);
    }
    for (const text of s.landmarks) {
      try {
        await page.locator(`text=${text} >> visible=true`).first().waitFor({ state: "visible", timeout: 15000 });
      } catch (e) {
        throw new Error(`${s.name}: landmark "${text}" not found on ${page.url()}`, { cause: e });
      }
    }
    await page.evaluate(() => document.fonts.ready);
    if (s.zoom !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, s.zoom);
    await page.waitForTimeout(600); // let late layout and images settle before the clip opens
    start = Date.now() - t0;
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
    raw = await page.video().path();
  } finally {
    await ctx.close(); // finalises the raw recording
  }
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error",
    "-ss", (start / 1000).toFixed(3), "-i", raw, "-t", (s.ms / 1000).toFixed(3),
    "-an", "-c:v", "libvpx-vp9", "-b:v", "4M", "-deadline", "good", "-cpu-used", "4", "-r", "30",
    tmpClip(s),
  ], { stdio: "inherit" });
  const size = statSync(tmpClip(s)).size;
  if (size < MIN_BYTES) throw new Error(`${s.name}: clip is only ${size} bytes (< ${MIN_BYTES})`);
  console.log(`${s.name}: recorded ${(size / 1e6).toFixed(1)} MB`);
}

mkdirSync(OUT, { recursive: true });
for (const s of shots) rmSync(tmpDir(s), { recursive: true, force: true });
let ok = false;
const browser = await chromium.launch();
try {
  for (const s of shots) await record(browser, s);
  // Every clip succeeded: replace the old ones.
  for (const s of shots) {
    renameSync(tmpClip(s), `${OUT}/${s.name}.webm`);
    console.log(`${s.name}: ${OUT}/${s.name}.webm`);
  }
  ok = true;
} catch (e) {
  console.error(`record-footage FAILED, existing clips left untouched: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser.close();
  for (const s of shots) rmSync(tmpDir(s), { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
