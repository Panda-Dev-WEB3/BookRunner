// Demo recorder: drives the local testnet app in headless Chromium at 1920x1080 and records it with Playwright's
// recordVideo, with a visible synthetic cursor, human-paced input and a step log for caption timing.
//
//   const { webm, stepsJson } = await recordScenario({
//     name: "my-clip", baseUrl: server.url, wallet: false,
//     run: async ({ page, step, click, type, scrollTo, wait, expectText }) => { ... },
//   });
//
// Outputs (video/public/demos/, or `outDir`): <name>.webm and <name>.steps.json = { name, startedAt, steps: [{ key, tMs }] }.
// tMs is milliseconds since the recording's start: Playwright starts the video when the page is created, so the
// reference clock is read immediately before context.newPage() (see recorder-log.mjs for the error bound).
// The video is written to a temp dir and renamed to <name>.webm only after `run` succeeded and the context closed
// (Playwright finalises the file at close); on any failure a screenshot goes to <name>-fail.png, the temp dir is
// removed, any previous <name>.webm is left untouched, and the error is rethrown (callers exit non-zero).
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertScenarioName, buildStepsDoc, createStepLog, movePath } from "./recorder-log.mjs";
import { DEMO_CHAIN_ID, DEMO_RPC_URL, installDemoWallet, loadDemoAccount } from "./wallet-node.mjs";

const VIDEO_DIR = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_OUT_DIR = join(VIDEO_DIR, "public/demos");
const CURSOR_SCRIPT = fileURLToPath(new URL("./cursor-inject.js", import.meta.url));
const VIEWPORT = { width: 1920, height: 1080 };
const MOVE_PAUSE_MS = 16; // between interpolated mouse positions (~60 Hz), so the move is visible in the video
const ACTION_TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.name         file stem: [A-Za-z0-9_-]
 * @param {string} o.baseUrl      page opened first (e.g. server.url = http://localhost:PORT/app/)
 * @param {boolean} [o.wallet]    install the demo wallet (needs video/.secrets/demo-wallet.json); handle on ctx.wallet
 * @param {(ctx: object) => Promise<void>} o.run
 * @param {string} [o.outDir]
 * @param {number} [o.offsetMs]   measured video-start correction subtracted from every step time (default 0)
 */
export async function recordScenario({ name, baseUrl, wallet = false, run, outDir = DEFAULT_OUT_DIR, offsetMs = 0 }) {
  assertScenarioName(name);
  mkdirSync(outDir, { recursive: true });
  const tmpDir = mkdtempSync(join(outDir, `.rec-${name}-`));
  const finalWebm = join(outDir, `${name}.webm`);
  const finalSteps = join(outDir, `${name}.steps.json`);
  const failShot = join(outDir, `${name}-fail.png`);

  const browser = await chromium.launch();
  let context;
  let page;
  let ok = false;
  try {
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      recordVideo: { dir: tmpDir, size: VIEWPORT },
    });
    await context.addInitScript({ path: CURSOR_SCRIPT });
    const startedAtMs = Date.now();
    const t0 = performance.now(); // reference clock: video starts at page creation, i.e. just after this line
    page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));

    const log = createStepLog({ t0, offsetMs });
    let walletHandle;
    if (wallet) {
      const account = loadDemoAccount(join(VIDEO_DIR, ".secrets/demo-wallet.json"));
      walletHandle = await installDemoWallet(page, { account, appOrigin: new URL(baseUrl).origin, rpcUrl: DEMO_RPC_URL, chainId: DEMO_CHAIN_ID });
    }

    const ctx = makeContext({ page, log, baseUrl, wallet: walletHandle, name });
    await page.goto(baseUrl, { waitUntil: "load", timeout: 45_000 });
    await run(ctx);
    await sleep(600); // hold the last frame briefly

    const steps = log.steps();
    const doc = buildStepsDoc({ name, startedAtMs, steps });
    await context.close(); // finalises the webm
    context = undefined;
    const tmpWebm = await page.video().path();
    if (!existsSync(tmpWebm)) throw new Error(`recorder: Playwright did not write ${tmpWebm}`);
    renameSync(tmpWebm, finalWebm);
    writeFileSync(finalSteps, `${JSON.stringify(doc, null, 2)}\n`);
    ok = true;
    return { webm: finalWebm, stepsJson: finalSteps, steps };
  } catch (e) {
    if (page && !page.isClosed()) await page.screenshot({ path: failShot }).then(() => console.error(`[${name}] failure screenshot: ${failShot}`), () => {});
    throw e;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
    if (!ok) console.error(`[${name}] recording discarded`);
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

  async function glideTo(locator) {
    await locator.waitFor({ state: "visible" });
    await locator.scrollIntoViewIfNeeded();
    let box = await locator.boundingBox();
    if (!box) throw new Error(`recorder: ${locator} has no box`);
    // scrollIntoViewIfNeeded may have moved the page: read the box again once layout settled.
    await sleep(120);
    box = (await locator.boundingBox()) ?? box;
    await moveTo(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(180); // the cursor rests on the target a beat before the click
  }

  const ctx = {
    page,
    baseUrl,
    wallet,
    /** Marks `key` in the step log at the current time (ms since the recording's start). */
    step: (key) => log.step(key),
    /** Glides the cursor to the centre of `locator`, then clicks it. */
    async click(locator) {
      await glideTo(locator);
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    },
    /** Clicks the field, then types `text` one key at a time (60 ms per character). */
    async type(locator, text) {
      await ctx.click(locator);
      await locator.pressSequentially(text, { delay: 60 });
    },
    /** Smooth-scrolls `locator` into the middle of the viewport (nested scroll containers included), waits to settle. */
    async scrollTo(locator) {
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
    },
    wait: (ms) => sleep(ms),
    /** Waits (up to ~20 s) until `text` is visible; use it as a landmark. Throws, so the run fails, if it never is. */
    async expectText(text) {
      try {
        await page.getByText(text).first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      } catch (e) {
        throw new Error(`[${name}] expected visible text ${JSON.stringify(text)}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    },
  };
  return ctx;
}
