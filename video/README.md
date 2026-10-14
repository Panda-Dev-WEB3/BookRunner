# BookRunner overview video

Remotion project (React) that renders the overview video in three formats: `Overview16x9`, `Overview1x1`, `Overview9x16`.

Everything runs in Docker (Remotion's compositor and headless Chrome are Linux binaries; Linux `node_modules` and the
browser cache live in named volumes, not on the host disk). `video/` is deliberately not a bun workspace.

```bash
bash scripts/video.sh npm ci                  # install (first run builds the bookrunner-video:1 image)
bash scripts/video.sh npm run typecheck
bash scripts/video.sh npx remotion still src/index.ts Overview16x9 out/check.png --frame=30
```

Output lands in `video/out/` (gitignored). Fonts: Source Serif 4 (`public/fonts/`, copied from the site) and Inter
(`@remotion/google-fonts`). Brand colours and format sizes are in `src/theme.ts`.
