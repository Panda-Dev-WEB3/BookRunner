// Demo recorder: drives the local testnet app in headless Chromium at 1920x1080 and records it with Playwright's
// recordVideo, with a visible synthetic cursor, human-paced input and a step log for caption timing.
//
//   await runScenario({ name: "my-clip", wallet: false, run: async ({ page, step, click, type, scrollTo, wait, expectText }) => { ... } });
//   // or, with your own server: const { webm, stepsJson } = await recordScenario({ name, baseUrl, wallet, run });
//
// Outputs (video/public/demos/, or `outDir`): <name>.webm and <name>.steps.json =
//   { name, startedAt, videoOffsetMs, calibrated, steps: [{ key, tMs }] }.
// Playwright records 25 fps webm; the renderer resamples to the 30 fps output.
//
// Step times (tMs) are in VIDEO time. Playwright starts the video when the page is created, so a reference clock t0 is
// read immediately before context.newPage(); but the true offset (page-creation latency + screencast latency) is
// measured, not assumed: right after page creation a solid magenta overlay is shown for 400 ms and the step `__sync`
// is logged just before it; once the webm is finalised ffmpeg decodes its first seconds (100 Hz, 16x9) and the first
// magenta frame gives markerMs. videoOffsetMs = markerMs - rawSyncTMs is applied to every step, so tMs is when the
// step's effect shows up in the webm. If the marker cannot be found (no ffmpeg), a warning is printed, the raw times
// are kept and steps.json says `calibrated: false`.
// Reserved step keys: `__sync` (calibration), `loaded` (logged after the initial goto: the app's first paint is done).
//
// Atomicity: video and steps are written to a temp dir inside outDir; only after `run` succeeded, the context closed
// and calibration ran are they promoted (steps.json first, then the webm, rolled back if the second rename fails),
// so a webm never exists without its steps file. On any failure a screenshot goes to <name>-fail.png, the temp dir is
// removed, any previous <name>.webm / <name>.steps.json is left untouched and the error is rethrown.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { applyVideoOffset, assertScenarioName, buildStepsDoc, createStepLog, findMarkerMs, movePath, readPng1x1 } from "./recorder-log.mjs";
import { startAppServer } from "./serve-app.mjs";
import { DEMO_CHAIN_ID, DEMO_RPC_URL, installDemoWallet, loadDemoAccount } from "./wallet-node.mjs";

const VIDEO_DIR = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_OUT_DIR = join(VIDEO_DIR, "public/demos");
const CURSOR_SCRIPT = fileURLToPath(new URL("./cursor-inject.js", import.meta.url));
const VIEWPORT = { width: 1920, height: 1080 };
const MOVE_PAUSE_MS = 16; // between interpolated mouse positions (~60 Hz), so the move is visible in the video
const ACTION_TIMEOUT_MS = 20_000;
const DEFAULT_SCENARIO_TIMEOUT_MS = 10 * 60_000;
const SYNC_MS = 400;
const SCAN_FPS = 100;
const SCAN_SECONDS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Playwright's bundled ffmpeg (or $FFMPEG_PATH, or `ffmpeg` on PATH). */
function locateFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? process.env.PLAYWRIGHT_BROWSERS_PATH : null;
  for (const dir of [root, "/ms-playwright", join(homedir(), ".cache/ms-playwright")]) {
    if (!dir || !existsSync(dir)) continue;
    for (const d of readdirSync(dir).filter((n) => n.startsWith("ffmpeg-")).sort().reverse()) {
      for (const bin of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win64.exe"]) if (existsSync(join(dir, d, bin))) return join(dir, d, bin);
    }
  }
  return "ffmpeg";
}

/**
 * Decodes the first seconds of `webm` to one 1x1 PNG per 10 ms (Playwright's bundled ffmpeg can only write PNG files:
 * no rawvideo/pipe muxers and no fps filter, so -r with cfr resamples), reads each frame's mean colour and returns the marker's video time in ms, or null.
 */
function measureMarkerMs(webm, workDir) {
  const dir = join(workDir, "sync-frames");
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    locateFfmpeg(),
    ["-v", "error", "-t", String(SCAN_SECONDS), "-i", webm, "-vf", "scale=w=1:h=1:flags=area", "-pix_fmt", "rgb24", "-r", String(SCAN_FPS), "-fps_mode", "cfr", join(dir, "f%04d.png")],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".png")).sort() : [];
  if (r.error || r.status !== 0 || !files.length) {
    console.error(`recorder: calibration could not decode the webm (${r.error?.message ?? r.stderr?.toString().trim().split(String.fromCharCode(10))[0] ?? "no output"})`);
    return null;
  }
  const px = Buffer.alloc(files.length * 3);
  files.forEach((f, i) => Buffer.from(readPng1x1(readFileSync(join(dir, f)))).copy(px, i * 3));
  return findMarkerMs(px, { frameBytes: 3, fps: SCAN_FPS });
}

function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: scenario watchdog expired after ${ms} ms`)), ms)));
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} o
 * @param {string} o.name         file stem: [A-Za-z0-9_-]
 * @param {string} o.baseUrl      page opened first (e.g. server.url = http://localhost:PORT/app/)
 * @param {boolean} [o.wallet]    install the demo wallet (needs video/.secrets/demo-wallet.json); handle on ctx.wallet
 * @param {(ctx: object) => Promise<void>} o.run
 * @param {string} [o.outDir]
 * @param {number} [o.scenarioTimeoutMs]  watchdog for `run` (default 10 min); expiry takes the failure path
 */
export async function recordScenario({ name, baseUrl, wallet = false, run, outDir = DEFAULT_OUT_DIR, scenarioTimeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS }) {
  assertScenarioName(name);
  mkdirSync(outDir, { recursive: true });
  const tmpDir = mkdtempSync(join(outDir, `.rec-${name}-`));
  const finalWebm = join(outDir, `${name}.webm`);
  const finalSteps = join(outDir, `${name}.steps.json`);
  const failShot = join(outDir, `${name}-fail.png`);

  let browser;
  let context;
  let page;
  let ok = false;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      recordVideo: { dir: tmpDir, size: VIEWPORT },
    });
    await context.addInitScript({ path: CURSOR_SCRIPT });
    const startedAtMs = Date.now();
    const t0 = performance.now(); // reference clock: the video starts at page creation, i.e. just after this line
    page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));

    const log = createStepLog({ t0 });
    let walletHandle;
    if (wallet) {
      const account = loadDemoAccount(join(VIDEO_DIR, ".secrets/demo-wallet.json"));
      walletHandle = await installDemoWallet(page, { account, appOrigin: new URL(baseUrl).origin, rpcUrl: DEMO_RPC_URL, chainId: DEMO_CHAIN_ID });
    }

    // Calibration flash on the blank first page (see the header): logged first, shown right after.
    log.step("__sync");
    await page.evaluate((ms) => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483647";
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), ms);
    }, SYNC_MS);
    await sleep(SYNC_MS + 250);

    const ctx = makeContext({ page, log, baseUrl, wallet: walletHandle, name });
    await page.goto(baseUrl, { waitUntil: "load", timeout: 45_000 });
    log.step("loaded");
    await withTimeout(run(ctx), scenarioTimeoutMs, name);
    await sleep(600); // hold the last frame briefly

    const raw = log.steps();
    await context.close(); // finalises the webm
    context = undefined;
    const tmpWebm = await page.video().path();
    if (!existsSync(tmpWebm)) throw new Error(`recorder: Playwright did not write ${tmpWebm}`);

    const markerMs = measureMarkerMs(tmpWebm, tmpDir);
    const calibrated = markerMs !== null;
    const videoOffsetMs = calibrated ? markerMs - raw[0].tMs : 0;
    if (calibrated) console.log(`[${name}] calibration: sync marker at ${markerMs} ms in the webm, step __sync at ${raw[0].tMs} ms -> videoOffsetMs ${videoOffsetMs}`);
    else console.error(`[${name}] WARNING: sync marker not found in the webm; step times are uncalibrated (calibrated:false)`);
    const steps = calibrated ? applyVideoOffset(raw, videoOffsetMs) : raw;
    const doc = buildStepsDoc({ name, startedAtMs, steps, videoOffsetMs, calibrated });

    const tmpSteps = join(tmpDir, `${name}.steps.json`);
    writeFileSync(tmpSteps, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(tmpSteps, finalSteps);
    try {
      renameSync(tmpWebm, finalWebm);
    } catch (e) {
      rmSync(finalSteps, { force: true }); // never leave a steps file without its webm
      throw e;
    }
    ok = true;
    return { webm: finalWebm, stepsJson: finalSteps, steps, videoOffsetMs, calibrated };
  } catch (e) {
    if (page && !page.isClosed()) await page.screenshot({ path: failShot }).then(() => console.error(`[${name}] failure screenshot: ${failShot}`), () => {});
    throw e;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
    if (!ok) console.error(`[${name}] recording discarded`);
  }
}

/**
 * Scenario entry point: starts the local app server (apps/web build, /trpc + /health proxied), records the scenario,
 * always closes the server, prints the result and sets process.exitCode = 1 on failure. Returns the result or null.
 * `path` is opened relative to the app root (e.g. "books"); the other options are recordScenario's.
 */
export async function runScenario({ path = "", port = Number(process.env.DEMO_PORT ?? 4610), distDir = process.env.APP_DIST ?? join(VIDEO_DIR, "../apps/web/dist"), ...opts }) {
  const server = await startAppServer({ distDir, port });
  try {
    const res = await recordScenario({ ...opts, baseUrl: new URL(path, server.url).href });
    console.log(`recorded ${res.webm}`);
    console.log(JSON.stringify(res.steps));
    return res;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return null;
  } finally {
    await server.close();
  }
}

function makeContext({ page, log, baseUrl, wallet, name }) {
  /** Last pointer position (viewport px); starts where the injected cursor starts. */
  let pos = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  async function moveTo(x, y) {
    for (const p of movePath(pos, { x, y })) {
      await page.mouse.move(p.x, p.y);
      await sleep(MOVE_PAUSE_MS);
    }
    pos = { x, y };
  }

  /** Is the box comfortably on screen (clear of the sticky header and the bottom edge)? */
  const onScreen = (b) => b.y >= 90 && b.y + b.height <= VIEWPORT.height - 30 && b.x >= 0 && b.x + b.width <= VIEWPORT.width;

  /** Smooth-scrolls `locator` into the middle of the viewport (nested scroll containers included), waits to settle. */
  async function scrollTo(locator) {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }));
    let last = Number.NaN;
    let stable = 0;
    for (let i = 0; i < 100 && stable < 5; i++) {
      await sleep(50);
      const top = await locator.evaluate((el) => Math.round(el.getBoundingClientRect().top));
      stable = top === last ? stable + 1 : 0;
      last = top;
    }
  }

  /** Smooth-scrolls to the target if it is off screen, glides the cursor onto its centre; re-glides if it moved. */
  async function glideTo(locator) {
    await locator.waitFor({ state: "visible" });
    let box = await locator.boundingBox();
    if (!box) throw new Error(`recorder: ${locator} has no box`);
    if (!onScreen(box)) await scrollTo(locator);
    for (let i = 0; i < 4; i++) {
      box = await locator.boundingBox();
      if (!box) throw new Error(`recorder: ${locator} has no box`);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (i > 0 && Math.hypot(cx - pos.x, cy - pos.y) <= 2) break; // already on the (settled) centre
      await moveTo(cx, cy);
      await sleep(i === 0 ? 180 : 60); // the cursor rests on the target a beat before the click
    }
  }

  const ctx = {
    page,
    baseUrl,
    wallet,
    /** Marks `key` in the step log at the current time (reserved: `__sync`, `loaded`). */
    step: (key) => log.step(key),
    /**
     * Glides the cursor to the centre of `locator` (smooth-scrolling it into view first if needed) and clicks exactly
     * where the cursor is, once the element is enabled and not covered. The cursor never teleports.
     */
    async click(locator, { timeout = ACTION_TIMEOUT_MS } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        await glideTo(locator);
        const ready = await locator
          .evaluate((el, p) => {
            const hit = document.elementFromPoint(p.x, p.y);
            return !el.matches(":disabled") && !!hit && (el === hit || el.contains(hit) || hit.contains(el));
          }, pos)
          .catch(() => false);
        if (ready) break;
        if (Date.now() > deadline) throw new Error(`[${name}] ${locator} is disabled or covered at its centre`);
        await sleep(150);
      }
      await page.mouse.click(pos.x, pos.y, { delay: 60 });
    },
    /** Clicks the field, clears it, then types `text` one key at a time (60 ms per character). */
    async type(locator, text) {
      await ctx.click(locator);
      await locator.fill("");
      await locator.pressSequentially(text, { delay: 60 });
    },
    scrollTo,
    wait: (ms) => sleep(ms),
    /** Waits (default 20 s, `{ timeout }` ms to override) until `text` is visible; a landmark. Throws if it never is. */
    async expectText(text, { timeout = ACTION_TIMEOUT_MS } = {}) {
      try {
        await page.getByText(text).first().waitFor({ state: "visible", timeout });
      } catch (e) {
        throw new Error(`[${name}] expected visible text ${JSON.stringify(text)} within ${timeout} ms: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    },
    /** Waits (default 20 s, `{ timeout }` ms) until `locator` is visible, with a named error. */
    async waitFor(locator, { timeout = ACTION_TIMEOUT_MS } = {}) {
      try {
        await locator.waitFor({ state: "visible", timeout });
      } catch (e) {
        throw new Error(`[${name}] ${locator} not visible within ${timeout} ms: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    },
  };
  return ctx;
}
