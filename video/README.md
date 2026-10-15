# BookRunner overview video

Remotion project (React) that renders the overview video in three formats: `Overview16x9`, `Overview1x1`, `Overview9x16`.

Everything runs in Docker (Remotion's compositor and headless Chrome are Linux binaries; Linux `node_modules` and the
browser cache live in named volumes, not on the host disk). `video/` is deliberately not a bun workspace.

## Workflow

Run from the repository root:

```bash
bash scripts/video.sh npm ci                  # install (first run builds the bookrunner-video:1 image)
bash scripts/video.sh npm run typecheck
bash scripts/video.sh footage                 # record the live testnet pages (dashboard, status) for scene 8
bash scripts/video.sh npm run studio          # (optional) Remotion Studio
bash scripts/video.sh npm run stills          # review stills, one per scene per format -> out/stills/<format>/
bash scripts/video.sh npm run render          # full render: 3 MP4s + 3 posters -> out/
```

- **Footage is gitignored** (`public/footage/`). Scene 8 (Live) plays the recorded testnet pages, so run `footage`
  before rendering, and again right before a final render so dates and "x min ago" labels are current. The recorder
  fails loudly if the live site is degraded.
- **Edit copy:** all on-screen words live in `src/copy.ts` (`COPY`); the scene files only render it. After editing,
  run `node_modules/bun/bin/bun.exe test video/test` (checks every scene has copy and the repo copy rules; the CI
  linter `scripts/check-copy.ts` scans the same file), then regenerate the stills.
- **Edit timing / look:** scene order and lengths are in `src/timeline.ts` (30 fps, 4500 frames = 2:30). Formats and
  brand colours are in `src/theme.ts`. Fonts: Source Serif 4 (`public/fonts/`, copied from the site) and Inter
  (`@remotion/google-fonts`).
- **Stills** render each scene at 70% of its length, once per format; use them for review before a full render.
- **Render outputs** (all in `video/out/`, gitignored): `bookrunner-overview-16x9.mp4`, `-1x1.mp4`, `-9x16.mp4`
  (H.264, CRF 18, yuv420p, no audio) and a poster PNG of the same name for each (frame `hook + 250`). If a file is
  too large, raise the `CRF` constant at the top of `scripts/render.mjs`.
- Inspect an encoded file with Remotion's bundled ffprobe/ffmpeg:
  `bash scripts/video.sh npx remotion ffprobe out/bookrunner-overview-16x9.mp4`.

## Demo harness (product demos)

Screen-recorded demos of the operator app on Robinhood Chain testnet (spec:
`docs/superpowers/specs/2026-10-14-product-demo-videos-design.md`). Scripts live in `demo/` and run in the Playwright
image (`mcr.microsoft.com/playwright:v1.64.1-noble`, Playwright 1.64.1 + viem 2.57.2 in the
`bookrunner-video-demo-node-modules` volume):

```bash
bash scripts/video.sh app-build         # bun install + testnet build of apps/web -> apps/web/dist (base /app/, API same-origin)
bash scripts/video.sh demo new-wallet   # once: creates video/.secrets/demo-wallet.json, prints only the address
bash scripts/video.sh demo smoke        # serve + connect the demo wallet, no transaction -> public/demos/smoke-connected.png
bash scripts/video.sh demo recorder-smoke  # ~10 s recorder check -> public/demos/recorder-smoke.webm + .steps.json (demo/recorder.mjs: runScenario / recordScenario; step times are calibrated against the webm via a sync flash)
bash scripts/video.sh demo run 4        # record clip 1|2|3|4|all -> public/demos/<n>-<id>.webm + .steps.json (demo/run.mjs, demo/scenarios/)
bash scripts/video.sh demo frames 4-risk  # 3 review stills -> public/demos/frames/ (or: frames <name> 5 | frames <name> 12,30.5)
```

- **App build:** `app-build` runs on the host: `bun install --frozen-lockfile`, then
  `MSYS_NO_PATHCONV=1 VITE_API_URL=same-origin WEB_BASE=/app/ node node_modules/vite/bin/vite.js build --mode testnet`
  in `apps/web` (vite through node: bun-spawned vite and `node_modules/.bin` shims are blocked on this PC;
  `MSYS_NO_PATHCONV` stops Git Bash from turning `/app/` into a Windows path). The build is mounted read-only into
  the container at `/app-dist`. It deletes and replaces any existing `apps/web/dist` (rerun a normal build afterwards
  if you need one).
- **Local server** (`demo/serve-app.mjs`, `startAppServer`): serves the build at `http://localhost:4610/app/` (SPA
  fallback) and proxies `/trpc/*` and `/health` to `https://bookrunner.tech` with Host/Origin set to that site (the live
  API only allows its own origin). tRPC GETs (queries) pass; a POST passes only for the prepare-tx procedures in
  `TRPC_WRITE_ALLOW` (`tranche.subscribe`, `charter.file`), every procedure of a batch checked; anything else gets 403.
- **Demo wallet** (`demo/wallet-inject.js` + `demo/wallet-node.mjs`, `installDemoWallet`): an EIP-6963 provider named
  "Demo wallet" in the page; every request goes to Node, which answers account / chain methods, forwards reads to
  `https://rpc.testnet.chain.robinhood.com`, and signs `eth_sendTransaction` with viem. Only chain 46630 is accepted, and only
  requests from the local app origin (exposeBinding origin check; other frames get 4100).
  The key stays in `video/.secrets/demo-wallet.json` (gitignored): never logged, never sent to the page. It needs test
  ETH for gas (funded once from the testnet funder on the server).
- **Clips** (`demo/scenarios/`, run by `demo/run.mjs`): 1 site (public https://bookrunner.tech, no wallet), 2 allocator
  (demo wallet: mints 10,000 test USDC, approves and deposits 1,000 test USDC into NVDA Junior: the only clip that sends
  transactions, all on testnet 46630; every receipt must be `success`), 3 sponsor (file-a-charter form up to the prepared
  filing, never signed), 4 risk (risk, agents, marks, proof check, waterfall; no wallet). Each scenario exports its ordered
  step keys; `run.mjs` keeps a recording only if every key was logged in order. Captions: `src/demo-copy.ts`
  (checked by `test/demo-copy.test.ts` and `scripts/check-copy.ts`). Clip 2 spends test gas and deposits test USDC on every run.
- Outputs (`public/demos/`) are gitignored. Unit tests: `node_modules/bun/bin/bun.exe test video/test`.
