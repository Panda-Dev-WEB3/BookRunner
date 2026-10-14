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
