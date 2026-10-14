// Review stills: one frame per scene per format, at 70% through the scene (everything has animated in).
// Output: out/stills/<format>/<nn>-<scene id>.png. Exits non-zero on any failure.
// Runs under plain node 22 (type stripping), so the scene table is imported from src/timeline.ts, not duplicated.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { FORMATS } from "../src/theme.ts";
import { SCENES, sceneStart } from "../src/timeline.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "out", "stills");

try {
  const serveUrl = await bundle({ entryPoint: path.join(root, "src", "index.ts") });
  let count = 0;
  for (const [format, { id }] of Object.entries(FORMATS)) {
    const composition = await selectComposition({ serveUrl, id });
    const dir = path.join(outRoot, format);
    mkdirSync(dir, { recursive: true });
    for (const [i, scene] of SCENES.entries()) {
      const frame = sceneStart(scene.id) + Math.round(scene.frames * 0.7);
      const output = path.join(dir, `${String(i + 1).padStart(2, "0")}-${scene.id}.png`);
      await renderStill({ composition, serveUrl, output, frame, imageFormat: "png", overwrite: true });
      console.log(`${format}/${path.basename(output)}  (${id} frame ${frame})`);
      count++;
    }
  }
  console.log(`done: ${count} stills in ${outRoot}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
