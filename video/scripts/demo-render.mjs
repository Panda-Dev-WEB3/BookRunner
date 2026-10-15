// Product demo render: one bundle, then each clip to an H.264 MP4 (muted) plus a poster PNG.
// Output: out/bookrunner-demo-<n>-<id>.mp4 and .png (poster: the middle of the clip's second caption).
//   node scripts/demo-render.mjs [1 2 3 4]      (default: all clips)
// Runs under plain node 22 (type stripping): the plan comes from src/demos/segments.ts, the same code the composition uses.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { DEMO_COPY } from "../src/demo-copy.ts";
import { DEMO_CLIPS, DEMO_FPS, DEMO_TIMING, cueMidFrame, planDemo } from "../src/demos/segments.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const CRF = 18; // H.264 quality (lower = larger file)
const pick = process.argv.slice(2).map(Number);
const clips = DEMO_CLIPS.filter((c) => !pick.length || pick.includes(c.n));
if (!clips.length) {
  console.error(`no such clip: ${process.argv.slice(2).join(" ")} (1-4)`);
  process.exit(2);
}

try {
  mkdirSync(outDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: path.join(root, "src", "index.ts") });
  for (const c of clips) {
    const log = JSON.parse(readFileSync(path.join(root, "public", "demos", `${c.name}.steps.json`), "utf8"));
    const plan = planDemo(log, Object.keys(DEMO_COPY[c.id].steps), c.lead);
    const { durationInSeconds } = await getVideoMetadata(path.join(root, "public", "demos", `${c.name}.webm`));
    if (plan.endMs / 1000 > durationInSeconds) throw new Error(`${c.name}.webm is ${durationInSeconds} s, the plan plays to ${plan.endMs / 1000} s`);
    const seconds = plan.totalFrames / DEMO_FPS;
    if (seconds < DEMO_TIMING.minSeconds || seconds > DEMO_TIMING.maxSeconds) throw new Error(`${c.comp} is ${seconds.toFixed(1)} s, outside ${DEMO_TIMING.minSeconds}-${DEMO_TIMING.maxSeconds} s`);
    const composition = await selectComposition({ serveUrl, id: c.comp, inputProps: { clip: c.n, plan: null } });
    if (composition.durationInFrames !== plan.totalFrames) throw new Error(`${c.comp}: composition has ${composition.durationInFrames} frames, plan ${plan.totalFrames}`);
    const base = path.join(outDir, `bookrunner-demo-${c.name}`);
    let lastPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: CRF,
      pixelFormat: "yuv420p",
      muted: true,
      outputLocation: `${base}.mp4`,
      overwrite: true,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          console.log(`${c.comp}: ${pct}%`);
        }
      },
    });
    console.log(`wrote ${base}.mp4 (${seconds.toFixed(1)} s, ${plan.totalFrames} frames)`);
    const poster = cueMidFrame(plan.captions[Math.min(1, plan.captions.length - 1)]);
    await renderStill({ composition, serveUrl, output: `${base}.png`, frame: poster, imageFormat: "png", overwrite: true });
    console.log(`wrote ${base}.png (frame ${poster})`);
  }
  console.log("done");
} catch (err) {
  console.error(err);
  process.exit(1);
}
