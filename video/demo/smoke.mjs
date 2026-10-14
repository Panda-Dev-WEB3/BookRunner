// Harness smoke test (no transaction): serves the app build, checks /app/ and the /health proxy, opens /app/ in
// headless Chromium with the demo wallet, connects "Demo wallet" through the app's Connect wallet dialog and checks
// the app shows the demo address on chain 46630. Screenshot: public/demos/smoke-connected.png.
// Run: bash scripts/video.sh demo smoke
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startAppServer } from "./serve-app.mjs";
import { DEMO_CHAIN_ID, DEMO_RPC_URL, installDemoWallet, loadDemoAccount } from "./wallet-node.mjs";

const VIDEO = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const DIST = process.env.APP_DIST ?? join(VIDEO, "../apps/web/dist");
const OUT = join(VIDEO, "public/demos");
const shortHex = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const check = (cond, msg) => {
  if (!cond) throw new Error(`smoke: ${msg}`);
  console.log(`ok  ${msg}`);
};

const server = await startAppServer({ distDir: DIST, port: Number(process.env.DEMO_PORT ?? 4610) });
let browser;
let page;
try {
  const html = await fetch(server.url).then(async (r) => ({ status: r.status, text: await r.text() }));
  check(html.status === 200 && html.text.includes('src="/app/assets/'), `GET ${server.url} -> app HTML`);
  const health = await fetch(new URL("/health", server.url)).then((r) => r.json());
  check(health.ok === true && health.chainId === DEMO_CHAIN_ID, `GET /health via proxy -> ${JSON.stringify(health)}`);

  const account = loadDemoAccount(join(VIDEO, ".secrets/demo-wallet.json"));
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  const wallet = await installDemoWallet(page, { account, rpcUrl: DEMO_RPC_URL, chainId: DEMO_CHAIN_ID });
  console.log(`demo wallet: ${wallet.address}`);

  const res = await page.goto(server.url, { waitUntil: "load", timeout: 45000 });
  check(res?.ok(), `page ${server.url} loaded`);
  await page.getByRole("button", { name: /^connect( wallet)?$/i }).first().click({ timeout: 30000 });
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  const option = dialog.getByRole("button", { name: /Demo wallet/ });
  await option.waitFor({ timeout: 15000 });
  check(true, `Connect dialog lists "Demo wallet"`);
  await option.click();

  const walletBtn = page.getByRole("button", { name: `Wallet ${shortHex(wallet.address)}. Open account menu` });
  await walletBtn.first().waitFor({ timeout: 30000 });
  check(true, `header shows ${shortHex(wallet.address)} (no "wrong network" label)`);
  check((await page.evaluate(() => window.__demoWalletProvider.request({ method: "eth_chainId" }))) === "0xb626", "provider eth_chainId 0xb626 (46630)");
  const wagmiChain = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("wagmi.store") ?? "null")?.state?.chainId ?? null;
    } catch {
      return null;
    }
  });
  check(wagmiChain === DEMO_CHAIN_ID, `wagmi state chainId ${wagmiChain}`);

  await walletBtn.first().click();
  const menu = page.getByRole("dialog", { name: "Account" });
  await menu.waitFor({ timeout: 10000 });
  const menuText = await menu.innerText();
  check(menuText.includes("Demo wallet") && menuText.includes("Robinhood Chain Testnet") && !menuText.includes("another network"), "account menu: Demo wallet on Robinhood Chain Testnet");
  await page.waitForTimeout(2500); // let the balances load for the screenshot
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "smoke-connected.png") });
  check(wallet.txs.length === 0, "no transaction sent");
  console.log("smoke: PASS");
} catch (e) {
  if (page) {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, "smoke-fail.png") }).catch(() => {});
  }
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
