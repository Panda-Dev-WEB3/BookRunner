# BookRunner overview video — design

Date: 2026-10-14 · Status: approved in conversation, awaiting spec review

## Goal

One polished ~2:30 overview video for **investors and counterparties** (Orderly, auditors, launch-capital
providers) that explains what BookRunner is, how capital and fee flow move, why it can be trusted, and that it
is live on Robinhood Chain testnet. Text on screen, **no voice** (plays muted in X / LinkedIn autoplay).
Delivered in three formats rendered from one source: **16:9** (1920×1080), **1:1** (1080×1080), **9:16**
(1080×1920).

## Storyboard (~150 s at 30 fps)

| # | Time | Scene | On screen |
|---|---|---|---|
| 1 | 0:00–0:10 | Hook | "Every perp market needs capital before its first trade." → logo + "Run the book." |
| 2 | 0:10–0:25 | The problem | A new market needs an insurance fund and market-making inventory; today that capital is ad hoc, opaque and nobody underwrites it. |
| 3 | 0:25–0:45 | A book per market | Allocators subscribe to Senior and Junior tranches; the book capitalises the market's insurance fund and inventory on the venue (animated flow). |
| 4 | 0:45–1:00 | Chartered, not improvised | A sponsor files a charter; the Risk Committee (model-jury verdict + three bonded members) approves it. |
| 5 | 1:00–1:20 | Agents under mandate | Agents quote and hedge inside limits enforced in code: width, skew, inventory, hedge band, drawdown kill. A breach revokes their keys. |
| 6 | 1:20–1:40 | How the money moves | Fee waterfall down: expenses → 10% protocol carry → Senior share → Junior residual. Losses up: Junior → Senior → backstop up to the pool. |
| 7 | 1:40–1:55 | Proof, not promises | Every mark is signed: NAV, inventory, P&L and a receipt root on-chain; one transaction per book per period. |
| 8 | 1:55–2:15 | Live today | Real footage: NVDA, TSLA, RHX5 books on Robinhood Chain testnet; live desk and status page. |
| 9 | 2:15–2:30 | What's next + CTA | Independent audit → guarded mainnet launch on Robinhood Chain. bookrunner.tech · @TryBookRunner. Disclaimer: testnet; not an offer; not available to US persons. |

### Copy rules

- Facts only, taken from README.md / docs/ARCHITECTURE.md: no invented figures, partners, dates or volumes.
- All on-screen text passes the repo copy rules (`packages/shared/src/copy.ts`): no APY/APR, yield, returns,
  target, guaranteed, protected/protection, insured, risk-free, "market-make for you", "<venue> partner".
- Status is stated honestly: "live on testnet"; nothing implies real funds at work.

## Visual style

- Brand identity of the site and the GitHub social preview: deep navy background, cream text, the blue
  engraved logo (`apps/site/public/assets/bookrunner-logo-transparent.png`), serif headlines and sans labels
  from the site's own font files (the woff2 files under `apps/site/public/assets/media/`, e.g. Source Serif 4).
- Diagrams in thin line art matching the engraved logo; capital moves as blue particles, losses in a muted red.
- Calm, deliberate motion; one idea per screen; captions legible on a phone with sound off.

## Build

- New workspace `apps/video/` (TypeScript + React + **Remotion**; the team is ≤ 3 people, within Remotion's
  free licence). Not deployed to the server.
- `src/copy.ts`: every on-screen string, in one file; `scripts/check-copy.ts` is extended to cover it.
- `src/theme.ts`: colours, fonts, timings. `src/scenes/*`: one component per scene; each receives the format
  (`landscape` / `square` / `portrait`) and lays itself out for it (no cropping).
- `src/Overview.tsx`: the timeline (scene order and durations) shared by the three compositions
  `Overview16x9`, `Overview1x1`, `Overview9x16`.
- Live footage: `scripts/record-footage.ts` drives headless Chrome over https://bookrunner.tech (`/dashboard/`,
  `/status/`) and writes clips to `apps/video/public/footage/` (gitignored; re-run to refresh).
- Render: `bun run render` → `apps/video/out/bookrunner-overview-{16x9,1x1,9x16}.mp4` (H.264, 30 fps) + a
  poster PNG each; `out/` is gitignored. ffmpeg comes with Remotion's renderer; Docker ffmpeg is the
  fallback for any post-processing.

## Verification

1. `bun run stills`: one still per scene per format → reviewed by the user before the full render.
2. Copy check passes on `apps/video/src/copy.ts`; typecheck passes.
3. Full render of the three MP4s; watched back end to end (frames sampled per scene) for overflow, legibility,
   timing; sent to the user.

## Out of scope

Voice-over, music, translations, hosting the videos on the site (possible follow-ups).
