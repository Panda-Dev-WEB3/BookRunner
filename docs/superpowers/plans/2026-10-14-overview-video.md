# BookRunner Overview Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ~2:30 text-on-screen overview video of BookRunner for investors and counterparties, rendered from one
Remotion source in 16:9, 1:1 and 9:16 (spec: `docs/superpowers/specs/2026-10-14-overview-video-design.md`).

**Architecture:** A standalone Remotion project in top-level `video/` (NOT a bun workspace: `apps/*` is a
workspace glob, and Remotion's native compositor is blocked by Windows application control on this PC and is
the wrong platform for Linux anyway). Everything Remotion runs inside Docker through `scripts/video.sh`
(the same pattern as `scripts/forge.sh`). Pure modules (`copy.ts`, `timeline.ts`) carry no Remotion import so
the repo's bun can test and copy-check them on Windows.

**Tech Stack:** Remotion 4.0.535 (`remotion`, `@remotion/cli`, `@remotion/google-fonts`), React 19.3.0,
TypeScript, Docker (`node:22-bookworm-slim`), Playwright 1.64.1 in `mcr.microsoft.com/playwright:v1.64.1-noble`
for the live-footage recording, bun (repo) for tests and the copy check.

## Global Constraints

- Formats: `landscape` 1920×1080, `square` 1080×1080, `portrait` 1080×1920; 30 fps; total 4500 frames (150 s).
- Text on screen only: no voice, no music.
- Every on-screen string lives in `video/src/copy.ts` and passes `packages/shared/src/copy.ts` rules (no APY/APR,
  yield, returns, target, guaranteed, protected/protection, insured, risk-free, "market-make for you",
  "<Orderly|Arcus|Chainlink> … partner").
- Facts only (README.md, docs/ARCHITECTURE.md). Status: "live on testnet". No invented figures, partners, dates.
- Brand: background `#0a1128` (deep `#070c1d`), panel `#13224f`, cream text `#f4f2ec`, muted `#8e9cbd`,
  accent blue `#2f5bea`, light blue `#b6c9ed`, loss red `#c0504d`. Headlines: Source Serif 4 (the site's
  `apps/site/public/assets/media/vEFF2_tTDB4M7-auWDN0ahZJW3IX2ih5nk3AucvUHf6kDXr4.woff2`, variable 200–900).
  Labels: Inter via `@remotion/google-fonts/Inter`. Logo: `apps/site/public/assets/bookrunner-logo-transparent.png`.
- Exact dependency versions (no ranges). `video/node_modules/`, `video/out/`, `video/public/footage/` gitignored.
- Docker paths from Git Bash need `MSYS_NO_PATHCONV=1`; Windows paths via `cygpath -w`.
- Bun on this PC: `node_modules/bun/bin/bun.exe` (not `node_modules/.bin/bun.exe`).

---

### Task 1: Scaffold `video/`, Docker runner, first still

**Files:**
- Create: `video/package.json`, `video/tsconfig.json`, `video/remotion.config.ts`, `video/Dockerfile`,
  `video/src/index.ts`, `video/src/Root.tsx`, `video/src/theme.ts`, `video/src/fonts.ts`,
  `video/public/fonts/source-serif-4.woff2` (copy of the site file above), `video/public/logo.png` (copy),
  `scripts/video.sh`, `video/README.md`
- Modify: `.gitignore` (add `video/node_modules/`, `video/out/`, `video/public/footage/`)

**Interfaces:**
- Produces: `type Format = "landscape" | "square" | "portrait"`; `FORMATS: Record<Format, {width:number;height:number;id:string}>`
  with ids `Overview16x9`, `Overview1x1`, `Overview9x16` (in `theme.ts`); `C` colour object and `FONT = {serif, sans}`
  (in `theme.ts`/`fonts.ts`); `bash scripts/video.sh <cmd…>` runs `<cmd…>` in the container with `video/` at `/work`.

- [ ] **Step 1: `video/package.json`**

```json
{
  "name": "bookrunner-video",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "studio": "remotion studio",
    "stills": "node scripts/stills.mjs",
    "render": "node scripts/render.mjs"
  },
  "dependencies": {
    "@remotion/cli": "4.0.535",
    "@remotion/google-fonts": "4.0.535",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "remotion": "4.0.535"
  },
  "devDependencies": {
    "@types/react": "19.2.2",
    "typescript": "6.0.3"
  }
}
```
(If `@types/react@19.2.2` does not exist, use the exact version `apps/web/package.json` pins.)

- [ ] **Step 2: Dockerfile** (Remotion's documented Linux deps)

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /work
```

- [ ] **Step 3: `scripts/video.sh`** — builds the image once, keeps Linux `node_modules` and Remotion's browser in
  named volumes so they never land on the Windows disk.

```bash
#!/usr/bin/env bash
# Run a command for the overview video (video/) inside Docker: Remotion's compositor and headless Chrome are
# Linux binaries here (Windows application control blocks native binaries under node_modules on this PC).
#   bash scripts/video.sh npm ci
#   bash scripts/video.sh npm run stills
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=bookrunner-video:1
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$ROOT/video"
HOSTDIR="$ROOT/video"; command -v cygpath >/dev/null && HOSTDIR="$(cygpath -w "$HOSTDIR")"
MSYS_NO_PATHCONV=1 exec docker run --rm -i \
  -v "$HOSTDIR:/work" \
  -v bookrunner-video-node-modules:/work/node_modules \
  -v bookrunner-video-cache:/root/.cache \
  "$IMAGE" "$@"
```
`git update-index --chmod=+x scripts/video.sh`.

- [ ] **Step 4: theme, fonts, root**

`video/src/theme.ts`:
```ts
export type Format = "landscape" | "square" | "portrait";
export const FPS = 30;
export const FORMATS: Record<Format, { width: number; height: number; id: string }> = {
  landscape: { width: 1920, height: 1080, id: "Overview16x9" },
  square: { width: 1080, height: 1080, id: "Overview1x1" },
  portrait: { width: 1080, height: 1920, id: "Overview9x16" },
};
export const C = {
  bg: "#0a1128", deep: "#070c1d", panel: "#13224f", cream: "#f4f2ec", muted: "#8e9cbd",
  blue: "#2f5bea", light: "#b6c9ed", loss: "#c0504d", line: "rgba(182,201,237,0.35)",
} as const;
/** Base type size per format (px); scenes scale from it so text stays phone-legible. */
export const BASE: Record<Format, number> = { landscape: 44, square: 46, portrait: 54 };
```

`video/src/fonts.ts`:
```ts
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { continueRender, delayRender, staticFile } from "remotion";
const { fontFamily: inter } = loadInter("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const handle = delayRender("serif font");
new FontFace("SourceSerif4", `url(${staticFile("fonts/source-serif-4.woff2")}) format("woff2")`, { weight: "200 900" })
  .load().then((f) => { document.fonts.add(f); continueRender(handle); });
export const FONT = { serif: "SourceSerif4, 'Times New Roman', serif", sans: `${inter}, Arial, sans-serif` };
```

`video/src/Root.tsx` registers one `<Composition>` per format (component `Overview`, `durationInFrames` from
Task 3's `TOTAL_FRAMES`; in this task use a temporary `Hello` component showing the logo and "Run the book."
in serif on `C.bg` so the pipeline can be proven). `video/src/index.ts`: `registerRoot(RemotionRoot)`.

- [ ] **Step 5: install and render a still**

Run: `bash scripts/video.sh npm install` (creates `video/package-lock.json`, commit it), then
`bash scripts/video.sh npx remotion still src/index.ts Overview16x9 out/check.png --frame=30`
Expected: `video/out/check.png` exists; read its PNG header → 1920×1080; open it and confirm serif text + logo.
Repeat for `Overview1x1` (1080×1080) and `Overview9x16` (1080×1920).

- [ ] **Step 6: typecheck** — `bash scripts/video.sh npx tsc --noEmit` → no errors.

- [ ] **Step 7: Commit** — `git add .gitignore scripts/video.sh video/ && git commit -m "video: Remotion project in Docker (3 formats, brand theme, fonts)"`

---

### Task 2: On-screen copy + copy check

**Files:**
- Create: `video/src/copy.ts`, `video/test/copy.test.ts`
- Modify: `scripts/check-copy.ts` (add `video/src/copy.ts` to the TS targets, same extractor as apps/web)

**Interfaces:**
- Produces: `export const COPY` — an object keyed by scene id (`hook`, `problem`, `book`, `charter`, `mandate`,
  `waterfall`, `proof`, `live`, `next`), each a record of named strings / string arrays. Scenes import only from here.

- [ ] **Step 1: failing test** `video/test/copy.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { checkCopy } from "../../packages/shared/src/copy";
import { COPY, SCENE_IDS } from "../src/copy";
const all = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(all) : v && typeof v === "object" ? Object.values(v).flatMap(all) : []);
describe("video copy", () => {
  test("every scene has copy", () => { for (const id of SCENE_IDS) expect(all(COPY[id]).length).toBeGreaterThan(0); });
  test("passes the repo copy rules", () => { expect(checkCopy(all(COPY).join("\n"))).toEqual([]); });
  test("states testnet status and the US-person restriction", () => {
    const text = all(COPY).join(" ");
    expect(text).toMatch(/testnet/i);
    expect(text).toMatch(/US persons/);
  });
});
```
Run: `node_modules/bun/bin/bun.exe test video/test/copy.test.ts` → FAIL (module missing).

- [ ] **Step 2: `video/src/copy.ts`** (exact strings)

```ts
export const SCENE_IDS = ["hook", "problem", "book", "charter", "mandate", "waterfall", "proof", "live", "next"] as const;
export type SceneId = (typeof SCENE_IDS)[number];
export const COPY = {
  hook: { line: "Every perp market needs capital before its first trade.", brand: "BookRunner", tagline: "Run the book." },
  problem: {
    title: "A new market needs two things on day one.",
    needs: ["An insurance fund", "Market-making inventory"],
    today: "Today that capital is ad hoc, opaque, and nobody underwrites it.",
  },
  book: {
    title: "One book per market.",
    allocators: "Capital allocators",
    senior: "Senior tranche", seniorNote: "First claim on fee flow · last loss",
    junior: "Junior tranche", juniorNote: "Residual fee flow · first loss",
    book: "The book",
    venue: ["Insurance fund", "Market-making inventory"],
    caption: "The book capitalises the market on the venue.",
  },
  charter: {
    title: "Chartered, not improvised.",
    sponsor: "Sponsor files a charter",
    fields: ["Underlying", "Venue", "Oracle plan", "Insurance-fund size", "Mandate", "Tranche terms"],
    committee: "Risk Committee",
    committeeNote: "Model-jury verdict + three bonded members",
    approved: "Approved charters become books.",
  },
  mandate: {
    title: "Agents quote it. Code holds the limits.",
    limits: ["Quote width", "Skew", "Inventory", "Hedge band", "Drawdown kill"],
    breach: "Breach → quotes cancelled, inventory flattened, keys revoked.",
  },
  waterfall: {
    title: "How the money moves.",
    feesLabel: "Fee flow",
    steps: ["Expenses", "Protocol carry · 10%", "Senior share", "Junior residual"],
    lossesLabel: "Losses",
    lossSteps: ["Junior", "Senior", "Backstop, up to the pool"],
  },
  proof: {
    title: "Proof, not promises.",
    items: ["NAV", "Inventory", "P&L", "Receipt root"],
    signed: "Every mark is signed and committed on-chain.",
    gas: "One transaction per book per period.",
  },
  live: {
    title: "Live today on Robinhood Chain testnet.",
    books: ["NVDA", "TSLA", "RHX5"],
    caption: "Three books marking on-chain, every period.",
    url: "bookrunner.tech/dashboard",
  },
  next: {
    steps: ["Independent audit", "Guarded mainnet launch", "Robinhood Chain"],
    url: "bookrunner.tech",
    x: "@TryBookRunner",
    disclaimer: "Testnet software. Not an offer. Stock-perp books are not available to US persons.",
  },
} as const satisfies Record<SceneId, Record<string, string | readonly string[]>>;
```

- [ ] **Step 3:** run the test → PASS. If `checkCopy` flags a string, reword it (never weaken the rule).

- [ ] **Step 4:** add `video/src/copy.ts` to `scripts/check-copy.ts` targets (read how apps/web TS targets are
  listed and add the file the same way); run `node_modules/bun/bin/bun.exe scripts/check-copy.ts` → passes and
  the file count rises by 1.

- [ ] **Step 5: Commit** — `git commit -m "video: on-screen copy (copy-checked)"`

---

### Task 3: Timeline + shared motion primitives

**Files:**
- Create: `video/src/timeline.ts`, `video/test/timeline.test.ts`, `video/src/ui/Stage.tsx`, `video/src/ui/Text.tsx`,
  `video/src/ui/motion.ts`, `video/src/ui/Flow.tsx`, `video/src/ui/Node.tsx`, `video/src/Overview.tsx`
- Modify: `video/src/Root.tsx` (use `Overview` + `TOTAL_FRAMES`)

**Interfaces:**
- Produces:
  - `timeline.ts`: `export const SCENES: ReadonlyArray<{id: SceneId; frames: number}>` = hook 300, problem 450,
    book 600, charter 450, mandate 600, waterfall 600, proof 450, live 600, next 450; `TOTAL_FRAMES = 4500`;
    `sceneStart(id: SceneId): number`.
  - `motion.ts`: `fadeInOut(frame, duration, inFrames = 15, outFrames = 15): number` (opacity 0→1→0),
    `rise(frame, delay = 0): {opacity:number; transform:string}` (spring 24px rise), `stagger(i: number, step = 8): number`.
  - `Stage`: `<Stage format>` full-frame background (`C.bg` → `C.deep` radial gradient + faint 64px grid like the
    social preview) with safe padding: landscape 120px, square 90px, portrait 90px/160px (x/y).
  - `Text`: `<Headline format size?>` serif 600, `<Label format>` sans 500 uppercase letter-spaced, `<Body format>` sans 400.
  - `Node`: rounded panel box (`C.panel` fill, 1.5px `C.line` border, radius 18) with title + optional note.
  - `Flow`: animated particle stream between two points: `<Flow from={[x,y]} to={[x,y]} color start count speed />`
    drawing small circles moving along a quadratic curve, appearing from frame `start`.
  - `Overview`: `<Overview format>` = `<Series>` of the nine scene components in `SCENES` order, each wrapped
    in `<Stage>` and a sequence-local fade (`fadeInOut`).

- [ ] **Step 1: failing test** `video/test/timeline.test.ts`

```ts
import { expect, test } from "bun:test";
import { SCENE_IDS } from "../src/copy";
import { SCENES, TOTAL_FRAMES, sceneStart } from "../src/timeline";
test("150 s at 30 fps", () => expect(TOTAL_FRAMES).toBe(4500));
test("durations sum to the total", () => expect(SCENES.reduce((a, s) => a + s.frames, 0)).toBe(TOTAL_FRAMES));
test("scene order matches the storyboard", () => expect(SCENES.map((s) => s.id)).toEqual([...SCENE_IDS]));
test("starts", () => { expect(sceneStart("hook")).toBe(0); expect(sceneStart("problem")).toBe(300); expect(sceneStart("next")).toBe(4050); });
```
Run → FAIL; implement `timeline.ts` (pure, imports only the `SceneId` type); run → PASS.

- [ ] **Step 2:** implement `motion.ts`, `Stage`, `Text`, `Node`, `Flow`, `Overview` (temporary scene stubs render
  the scene id as a `Headline` so the timeline is visible end to end).

- [ ] **Step 3: verify** — `bash scripts/video.sh npx tsc --noEmit`; render stills at frames 150, 2000, 4300 for
  each format; check stage padding keeps text off the edges in all three.

- [ ] **Step 4: Commit** — `git commit -m "video: timeline (150 s) and motion primitives"`

---

### Task 4: Scenes 1–3 (hook, problem, book)

**Files:** Create `video/src/scenes/Hook.tsx`, `Problem.tsx`, `Book.tsx`; modify `Overview.tsx` to use them.

**Interfaces:** each scene is `({ format }: { format: Format }) => JSX`, reads text only from `COPY[id]`, uses
`useCurrentFrame()` relative to its own sequence.

Scene specs (frames are sequence-local):
- **Hook (300):** 0–110 `COPY.hook.line` centred, serif, size `BASE*1.5`, words rise in with `stagger`. 120–150
  line fades. 140–300 logo scales 0.9→1 with opacity, `brand` (Label) above, `tagline` (Headline `BASE*2.2`) below.
  Portrait stacks vertically with logo 420px; landscape/square logo 360px.
- **Problem (450):** `title` top. Two `Node`s for `needs` appear at 40 and 70 (side by side in landscape, stacked
  in square/portrait), each with an empty dashed outline "slot" and a question mark that pulses. 220+ `today`
  appears below in `C.muted`, "nobody underwrites it" emphasised in cream.
- **Book (600):** `title` top. Left (top in portrait): `allocators` Node. Middle: `senior` and `junior` Nodes
  with their notes (Senior above Junior; Senior border `C.light`, Junior border `C.blue`). Right (bottom in
  portrait): `book` Node feeding two venue Nodes (`venue[0]`, `venue[1]`). `Flow` particles: allocators→tranches
  from 90, tranches→book from 200, book→venue from 320. 430+ `caption` fades in at bottom.

- [ ] **Step 1:** implement the three scenes.
- [ ] **Step 2:** stills at local frames (hook 60, 250; problem 300; book 500) for the three formats via
  `npx remotion still … --frame=<sceneStart+local>`; inspect each PNG: nothing clipped, nothing overlapping,
  smallest text ≥ 26 px.
- [ ] **Step 3:** typecheck; commit `video: scenes 1–3`.

---

### Task 5: Scenes 4–6 (charter, mandate, waterfall)

**Files:** Create `video/src/scenes/Charter.tsx`, `Mandate.tsx`, `Waterfall.tsx`; modify `Overview.tsx`.

Scene specs:
- **Charter (450):** a document card (cream outline, `sponsor` as header) whose `fields` tick in one by one
  (`stagger` 10) from 30. 200+ the card slides to the `committee` Node (`committeeNote` below, four small seat
  dots: one labelled model-jury icon, three bonded seats). 320 a stamp "Approved" draws on the card (blue ring);
  360+ `approved` caption.
- **Mandate (600):** `title`. An "agent" Node in the middle quoting: two horizontal bid/ask lines that wobble
  inside a translucent band (the mandate). `limits` listed as chips around it (appear 60+, `stagger` 12).
  360–420 the quote line pushes outside the band → band flashes `C.loss`, chips turn red, a key icon breaks;
  430+ `breach` caption.
- **Waterfall (600):** two columns (stacked in portrait): left `feesLabel` — `Flow` particles pouring down
  through four `steps` tiers in order (expenses, carry, Senior, Junior), each tier filling as particles arrive
  (30–330). Right `lossesLabel` — red particles absorbed upward: Junior bar drains first, then Senior, then
  Backstop (340–560). Arrows make the direction explicit (down for fees, up for losses).

- [ ] **Step 1:** implement. **Step 2:** stills (charter 120, 380; mandate 300, 450; waterfall 250, 500) × 3 formats,
  same inspection. **Step 3:** typecheck; commit `video: scenes 4–6`.

---

### Task 6: Scenes 7 and 9 (proof, next)

**Files:** Create `video/src/scenes/Proof.tsx`, `video/src/scenes/Next.tsx`; modify `Overview.tsx`.

- **Proof (450):** four `items` chips merge (30–180) into one block that gets a signature seal ("signed")
  and drops onto a chain of blocks at the bottom (220–320); `signed` caption 240+, `gas` caption 330+ with a
  single block highlighted per period.
- **Next (450):** horizontal roadmap (vertical in portrait) of `steps` with a moving marker (0–200); 200+ logo,
  `url` (Headline) and `x` (Label); 300+ `disclaimer` small (`BASE*0.55`, `C.muted`), held to the end.

- [ ] **Step 1:** implement. **Step 2:** stills (proof 300; next 120, 420) × 3. **Step 3:** typecheck; commit `video: scenes 7 and 9`.

---

### Task 7: Live footage + scene 8

**Files:**
- Create: `video/scripts/record-footage.mjs`, `video/src/scenes/Live.tsx`, `video/src/ui/BrowserFrame.tsx`
- Modify: `scripts/video.sh` (add `footage` subcommand that runs the Playwright image), `Overview.tsx`

**Interfaces:** footage files `video/public/footage/dashboard.webm` and `status.webm`, recorded at 1920×1080;
`<BrowserFrame src url format />` shows a clip inside a minimal browser chrome (address bar with `url`), scaled
to the format.

- [ ] **Step 1: recorder** `video/scripts/record-footage.mjs`

```js
// Records the live testnet pages for scene 8. Run: bash scripts/video.sh footage
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
const OUT = "/work/public/footage";
mkdirSync(OUT, { recursive: true });
const shots = [
  { name: "dashboard", url: "https://bookrunner.tech/dashboard/", ms: 14000, scroll: 900 },
  { name: "status", url: "https://bookrunner.tech/status/", ms: 9000, scroll: 0 },
];
const browser = await chromium.launch();
for (const s of shots) {
  const dir = `${OUT}/.tmp-${s.name}`;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  await page.goto(s.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  if (s.scroll) await page.evaluate(async (y) => { for (let i = 0; i <= 60; i++) { window.scrollTo(0, (y * i) / 60); await new Promise((r) => setTimeout(r, 120)); } }, s.scroll);
  await page.waitForTimeout(s.ms - 2500);
  await ctx.close();
  const [file] = readdirSync(dir);
  renameSync(`${dir}/${file}`, `${OUT}/${s.name}.webm`);
  rmSync(dir, { recursive: true });
}
await browser.close();
```
`scripts/video.sh footage` → `docker run --rm -v <video>:/work -w /work mcr.microsoft.com/playwright:v1.64.1-noble
sh -c "npm i --no-save playwright@1.64.1 && node scripts/record-footage.mjs"` (use a separate named volume for
that container's node_modules so it does not mix with the Remotion one).

- [ ] **Step 2:** run it; confirm both `.webm` files exist and are > 200 KB; render a still from each with
  `<OffthreadVideo>` to check they show the real pages (books, marks, status rows).
- [ ] **Step 3: Live (600):** `title` top; `BrowserFrame` playing `dashboard.webm` (0–360) then `status.webm`
  (360–600, cross-fade 20 frames); `books` as three chips with a pulsing green dot under/next to the frame;
  `caption` 120+; `url` in the frame's address bar. Landscape: frame 1440 wide; square: 960; portrait: 960 wide
  with chips and caption stacked below.
- [ ] **Step 4:** stills (live 200, 500) × 3; typecheck; commit `video: live testnet footage and scene 8`
  (footage itself stays gitignored).

---

### Task 8: Stills review, full render, delivery

**Files:** Create `video/scripts/stills.mjs`, `video/scripts/render.mjs`; update `video/README.md`.

- [ ] **Step 1: `stills.mjs`** — for each format id and each scene, render one still at
  `sceneStart(id) + round(frames*0.7)` to `out/stills/<format>/<nn>-<id>.png` using `npx remotion still`
  (spawnSync, inherit stdio, exit non-zero on failure).
- [ ] **Step 2:** `bash scripts/video.sh npm run stills` → 27 PNGs. **Checkpoint: send them to the user and wait
  for feedback before Step 3.** Apply feedback, re-run.
- [ ] **Step 3: `render.mjs`** — for each format: `npx remotion render src/index.ts <id>
  out/bookrunner-overview-<16x9|1x1|9x16>.mp4 --codec=h264 --crf=18 --pixel-format=yuv420p`, then a poster
  `npx remotion still … out/bookrunner-overview-<suffix>.png --frame=<sceneStart("hook")+250>`.
- [ ] **Step 4: verify** — each MP4 exists; `docker run --rm` the image with `npx remotion ffprobe` (or the
  bundled ffprobe) to confirm duration 150 s ±0.1, 30 fps, expected resolution; sample one frame per scene from
  the MP4 (`npx remotion still` is source-side, so instead extract frames with the bundled ffmpeg:
  `-ss <t> -frames:v 1`) and inspect them; file sizes reasonable (< 60 MB each).
- [ ] **Step 5:** README in `video/` (how to refresh footage, edit copy, render); commit
  `video: stills and render scripts`; send the three MP4s + posters to the user.
