// Full render: one bundle, then each format to an H.264 MP4 (muted) plus a poster PNG.
// Output: out/bookrunner-overview-<16x9|1x1|9x16>.mp4 and .png. Exits non-zero on any failure.
// Runs under plain node 22 (type stripping), so the scene table is imported from src/timeline.ts, not duplicated.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { FORMATS } from "../src/theme.ts";
import { sceneStart } from "../src/timeline.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const suffixes = { landscape: "16x9", square: "1x1", portrait: "9x16" };

try {
  mkdirSync(outDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: path.join(root, "src", "index.ts") });
  for (const [format, { id }] of Object.entries(FORMATS)) {
    const suffix = suffixes[format];
    if (!suffix) throw new Error(`no output suffix for format "${format}"`);
    const composition = await selectComposition({ serveUrl, id });
    const mp4 = path.join(outDir, `bookrunner-overview-${suffix}.mp4`);
    let lastPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: Number(process.env.CRF ?? 18),
      pixelFormat: "yuv420p",
      muted: true,
      outputLocation: mp4,
      overwrite: true,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          console.log(`${id}: ${pct}%`);
        }
      },
    });
    console.log(`wrote ${mp4}`);
    const poster = path.join(outDir, `bookrunner-overview-${suffix}.png`);
    await renderStill({
      composition,
      serveUrl,
      output: poster,
      frame: sceneStart("hook") + 250,
      imageFormat: "png",
      overwrite: true,
    });
    console.log(`wrote ${poster}`);
  }
  console.log("done");
} catch (err) {
  console.error(err);
  process.exit(1);
}
