// Review stills for the product demos: per clip, the title card, one frame per caption step (the middle of that
// caption's window) and the end card -> out/demo-stills/<n>/<nn>-<key>.png. Prints each clip's timing plan (length,
// speed-up). Fails if a recording is shorter than its plan or a clip falls outside 60–120 s.
//   node scripts/demo-stills.mjs [1 2 3 4]      (default: all clips; contact sheets: scripts/demo-sheet.py on the host)
// Runs under plain node 22 (type stripping): the plan comes from src/demos/segments.ts, the same code the composition uses.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderStill, selectComposition } from "@remotion/renderer";
import { DEMO_COPY } from "../src/demo-copy.ts";
import { DEMO_CLIPS, DEMO_FPS, DEMO_TIMING, cueMidFrame, planDemo } from "../src/demos/segments.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demos = path.join(root, "public", "demos");
const outRoot = path.join(root, "out", "demo-stills");
const pick = process.argv.slice(2).map(Number);
const clips = DEMO_CLIPS.filter((c) => !pick.length || pick.includes(c.n));
if (!clips.length) {
  console.error(`no such clip: ${process.argv.slice(2).join(" ")} (1-4)`);
  process.exit(2);
}

try {
  // Check every plan before the (slow) bundle.
  const plans = new Map();
  for (const c of clips) {
    const log = JSON.parse(readFileSync(path.join(demos, `${c.name}.steps.json`), "utf8"));
    const plan = planDemo(log, Object.keys(DEMO_COPY[c.id].steps), c.lead);
    const { durationInSeconds } = await getVideoMetadata(path.join(demos, `${c.name}.webm`));
    if (plan.endMs / 1000 > durationInSeconds) throw new Error(`${c.name}.webm is ${durationInSeconds} s, the plan plays to ${plan.endMs / 1000} s`);
    const seconds = plan.totalFrames / DEMO_FPS;
    const speed = plan.speedUp ? `x${plan.speedUp.rate} on gaps > ${plan.speedUp.minGapMs / 1000} s` : "1x (no speed-up)";
    console.log(`${c.comp}: ${seconds.toFixed(1)} s (${plan.totalFrames} frames), source ${(plan.startMs / 1000).toFixed(1)}-${(plan.endMs / 1000).toFixed(1)} s, ${speed}, ${plan.captions.length} captions`);
    if (seconds < DEMO_TIMING.minSeconds || seconds > DEMO_TIMING.maxSeconds) throw new Error(`${c.comp} is ${seconds.toFixed(1)} s, outside ${DEMO_TIMING.minSeconds}-${DEMO_TIMING.maxSeconds} s`);
    plans.set(c.n, plan);
  }

  const serveUrl = await bundle({ entryPoint: path.join(root, "src", "index.ts") });
  let count = 0;
  for (const c of clips) {
    const plan = plans.get(c.n);
    const composition = await selectComposition({ serveUrl, id: c.comp, inputProps: { clip: c.n, plan: null } });
    if (composition.durationInFrames !== plan.totalFrames) throw new Error(`${c.comp}: composition has ${composition.durationInFrames} frames, plan ${plan.totalFrames}`);
    const dir = path.join(outRoot, String(c.n));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const shots = [
      { name: "00-title", frame: Math.round(DEMO_TIMING.titleFrames * 0.6) },
      ...plan.captions.map((cue) => ({ name: `${String(cue.index + 1).padStart(2, "0")}-${cue.key}`, frame: cueMidFrame(cue) })),
      { name: "99-end", frame: plan.totalFrames - 1 },
    ];
    for (const s of shots) {
      const output = path.join(dir, `${s.name}.png`);
      await renderStill({ composition, serveUrl, output, frame: s.frame, imageFormat: "png", overwrite: true });
      console.log(`${c.n}/${s.name}.png  (${c.comp} frame ${s.frame}, ${(s.frame / DEMO_FPS).toFixed(1)} s)`);
      count++;
    }
  }
  console.log(`done: ${count} stills in ${outRoot}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
