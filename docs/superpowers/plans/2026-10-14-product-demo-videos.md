# Product Demo Videos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four 16:9 screen-recorded product demos of BookRunner on testnet with on-screen captions
(spec: `docs/superpowers/specs/2026-10-14-product-demo-videos-design.md`).

**Architecture:** Inside `video/` (Remotion project, everything runs in Docker via `scripts/video.sh`). A Playwright
"demo" container serves a testnet build of `apps/web` locally with a same-origin proxy to the live API, injects a
demo EIP-6963 wallet whose transactions are signed in Node, runs scripted scenarios, and writes a webm + step log
per clip. A Remotion `Demo` composition overlays captions from `video/src/demo-copy.ts` and renders MP4s.

**Tech Stack:** Playwright 1.64.1 (`mcr.microsoft.com/playwright:v1.64.1-noble`), viem (exact version used by the
repo's packages), Node 22 built-ins (http server/proxy), Remotion 4.0.535, bun (repo) for tests and copy check.

## Global Constraints

- Output: 1920×1080, 30 fps, H.264 MP4, no audio; each clip 60–120 s.
- Recordings/outputs gitignored: `video/public/footage/`, `video/out/`, plus new `video/public/demos/`, `video/.secrets/`.
- The demo wallet private key lives only in `video/.secrets/demo-wallet.json` (gitignored), is never logged, never
  typed into a page, never sent anywhere but used locally by viem to sign; only testnet chain id 46630 is accepted
  (refuse to sign for any other chain).
- The app under test is served on `localhost`; `/trpc` and `/health` proxied to `https://bookrunner.tech`. No
  writes to any API other than read queries and the prepare-tx procedures the app itself calls.
- Real transactions only in clip 2 (mint test USDC, approve, deposit) on testnet 46630. Clip 3 never sends (stop at
  review). No committee vote, no agent register/revoke.
- All caption words in `video/src/demo-copy.ts`; it passes `packages/shared/src/copy.ts` rules (no APY/APR, yield,
  returns, target, guaranteed, protected/protection, insured, risk-free, "market-make for you", "<venue> partner")
  and is added to `scripts/check-copy.ts` targets. Facts only (README.md, docs/ARCHITECTURE.md).
- Exact dependency versions. Docker from Git Bash: `MSYS_NO_PATHCONV=1` + `cygpath -w`. Bun on this PC:
  `node_modules/bun/bin/bun.exe`.

---

### Task 1: Local app server + demo wallet (harness)

**Files:** Create `video/demo/serve-app.mjs`, `video/demo/wallet-inject.js` (page-side provider),
`video/demo/wallet-node.mjs` (Node-side signer), `video/demo/new-wallet.mjs`, `video/demo/smoke.mjs`;
modify `scripts/video.sh` (subcommand `demo <script> [args]` running the Playwright image with the repo's
`apps/web` build mounted read-only and its own node_modules volume), `.gitignore`.

**Interfaces (produced):**
- `startAppServer({ distDir, port }) → Promise<{ url, close() }>`: serves `distDir` at `/app/` (SPA fallback to
  `/app/index.html`), proxies `/trpc/*` and `/health` to `https://bookrunner.tech` (stream body, keep method/headers,
  set `Host`/`Origin` to bookrunner.tech).
- `installDemoWallet(page, { account, rpcUrl, chainId: 46630 })`: `page.exposeFunction("__demoWalletRequest", …)`
  + `page.addInitScript(wallet-inject.js)`; the injected provider announces itself via EIP-6963
  (`info: { uuid, name: "Demo wallet", icon (data: SVG), rdns: "tech.bookrunner.demo" }`) and also sets
  `window.ethereum` only if absent; Node handles the methods listed in the spec; read methods are forwarded to the
  RPC; returns `{ address, txs: Array<{hash, status}> }` for assertions.
- `new-wallet.mjs`: creates `video/.secrets/demo-wallet.json` (`{ privateKey, address }`, mode 600) if missing and
  prints only the address.
- App build: `apps/web` built for testnet with `VITE_API_URL=same-origin`, `WEB_BASE=/app/` into `apps/web/dist`
  (build inside Docker if the host build is blocked; document the command in `video/README.md`).

- [ ] Step 1: build the app; implement `serve-app.mjs`; smoke: `/app/` returns the app HTML, `/health` returns the
  live API JSON (`"ok":true`) through the proxy.
- [ ] Step 2: implement the wallet pair + `new-wallet.mjs`; smoke (`smoke.mjs`): open `/app/`, connect "Demo wallet"
  via the app's connect modal, assert the app shows the demo address and chain 46630; no transaction.
- [ ] Step 3: unit test (bun, `video/test/demo-wallet.test.ts`) for the pure parts of `wallet-node.mjs` (method
  routing, chain-id refusal for ≠ 46630, hex formatting) without network.
- [ ] Step 4: commit `video: demo harness (local app server, demo EIP-6963 wallet)`.

**Controller step after Task 1 (not the implementer):** fund the demo address with ~0.02 test ETH from the funder,
run on the server, once.

### Task 2: Recorder framework

**Files:** Create `video/demo/recorder.mjs`; test `video/test/recorder-log.test.ts` (pure step-log helpers).

**Interfaces:** `recordScenario({ name, baseUrl, wallet?: boolean, run: async (ctx) => void }) → { webm, steps.json }`
where `ctx = { page, step(key), click(locator), type(locator, text), scrollTo(locator), wait(ms), expectText(text) }`:
visible synthetic cursor (injected DOM dot following real mouse moves; click ripple), smooth `mouse.move` in ~25
steps, typed input with per-char delay, `step(key)` appends `{ key, tMs }` (time since recording start) to the log;
viewport 1920×1080, `recordVideo` 1920×1080; on any failure: screenshot to `video/public/demos/<name>-fail.png`,
exit non-zero, never keep a partial webm as the final file (temp + rename).

- [ ] Steps: implement, unit-test the log helpers, smoke-record a 10 s scenario on `/app/` (step keys logged,
  cursor visible in a frame grabbed from the webm), commit `video: demo recorder`.

### Task 3: Scenarios 1–4

**Files:** Create `video/demo/scenarios/1-site.mjs`, `2-allocator.mjs`, `3-sponsor.mjs`, `4-risk.mjs`,
`video/demo/run.mjs` (CLI: `bash scripts/video.sh demo run <1|2|3|4|all>`), and `video/src/demo-copy.ts` (caption
text per step key, per clip: `{ title, subtitle, steps: Record<stepKey, string> }`), test
`video/test/demo-copy.test.ts` (every step key used by a scenario has a caption — scenarios export their ordered
step keys; copy rules pass); add `video/src/demo-copy.ts` to `scripts/check-copy.ts`.

Scenario content (selectors from the real pages; landmark text asserted before each step):
- 1-site (public, https://bookrunner.tech): hero → scroll to how-it-works → open `/dashboard/` (books table, desk
  activity) → `/status/` → `/documents/` rulebook scroll.
- 2-allocator (local app + demo wallet): Connect wallet → "Demo wallet" → account menu "Mint 10,000 test USDC"
  (tx) → `/app/books` → NVDA → NAV/marks/fills & hedges/fee waterfall panels → Invest: choose Junior (or Senior)
  → amount 1,000 → review shows 2 txs → "Sign and send 2 transactions" → wait for both receipts → `/app/portfolio`
  shows the deposit waiting for a mark → Withdraw tab (`?tab=withdraw`) shown, nothing sent. Assert every tx
  receipt `success`.
- 3-sponsor (local app + demo wallet connected, no sends): `/app/charters/new` fill the five steps with a plausible
  example market (e.g. underlying "AAPL", Orderly venue fields as the form expects), review step → "Validate and
  prepare filing" → prepared transactions listed → stop (do not click sign) → `/app/charters/1` (terms, jury
  rationale, votes) → `/app/committee` recent decisions → `/app/books/1`.
- 4-risk (local app, no wallet needed): `/app/risk` → `/app/agents` → `/app/books/1` signed marks panel → Verify
  panel (Merkle proof check) → fee waterfall / distribution panel.

- [ ] Steps: write `demo-copy.ts` + test (red → green), implement scenarios one by one, record each
  (`bash scripts/video.sh demo run <n>`), check the step log and grab 3 frames per webm, commit
  `video: demo scenarios 1–4`.

### Task 4: Caption composition + stills + render

**Files:** Create `video/src/demos/Demo.tsx`, `video/src/demos/Caption.tsx`, `video/src/demos/TitleCard.tsx`;
modify `video/src/Root.tsx` (register `Demo1Site` … `Demo4Risk`, 1920×1080, 30 fps, duration computed from the
step log via `calculateMetadata`), `video/scripts/stills.mjs` / `render.mjs` (or new `demo-render.mjs`) to render
`out/bookrunner-demo-<n>-<name>.mp4` + poster and one still per caption step to `out/demo-stills/<n>/`.

Composition: 3 s title card (clip title + subtitle from `DEMO_COPY`) → the webm via `<OffthreadVideo>` with long
idle gaps (> 2.5 s without a step) sped up ×3 (`playbackRate` per segment computed from the log) → lower-third
caption for the active step (brand style from `theme.ts`, ≥ 30 px, max two lines) → 3 s end card
(bookrunner.tech · @TryBookRunner · "Testnet software. Not an offer.").

- [ ] Steps: implement, unit-test the segment/speed-up math (pure function in `video/src/demos/segments.ts`,
  bun test), render stills → **checkpoint: send stills to the user**, then render the 4 MP4s, verify (1920×1080,
  30 fps, 60–120 s, frames sampled), update `video/README.md`, commit `video: product demo clips`.
