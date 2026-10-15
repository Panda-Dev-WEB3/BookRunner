// Grabs still frames from a recorded demo for review: public/demos/<name>.webm -> public/demos/frames/<name>-<s>.png
// (960 px wide). Uses Playwright's bundled ffmpeg (PNG output only).
//   bash scripts/video.sh demo frames 2-allocator          # 3 evenly spaced frames
//   bash scripts/video.sh demo frames 2-allocator 5        # 5 evenly spaced frames
//   bash scripts/video.sh demo frames 2-allocator 12,30.5  # frames at these seconds
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScenarioName } from "./recorder-log.mjs";

const VIDEO_DIR = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const [name, spec = "3"] = process.argv.slice(2);
assertScenarioName(name);
const webm = join(VIDEO_DIR, "public/demos", `${name}.webm`);
if (!existsSync(webm)) throw new Error(`frames: no ${webm}`);

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? process.env.PLAYWRIGHT_BROWSERS_PATH : "/ms-playwright";
const ffmpeg =
  process.env.FFMPEG_PATH ??
  (existsSync(browsers) ? readdirSync(browsers).filter((n) => n.startsWith("ffmpeg-")).map((d) => join(browsers, d, "ffmpeg-linux")).find(existsSync) : undefined) ??
  "ffmpeg";

const probe = spawnSync(ffmpeg, ["-i", webm], { encoding: "utf8" });
const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr ?? "");
const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
console.log(`${name}.webm: ${duration ? `${duration.toFixed(1)} s` : "duration unknown"}`);

const times = /^\d+$/.test(spec) ? Array.from({ length: Number(spec) }, (_, i) => Number((((i + 1) * duration) / (Number(spec) + 1)).toFixed(1))) : spec.split(",").map(Number);
if (!times.length || times.some((t) => !Number.isFinite(t) || t < 0)) throw new Error(`frames: bad times ${JSON.stringify(spec)}`);

const out = join(VIDEO_DIR, "public/demos/frames");
mkdirSync(out, { recursive: true });
for (const t of times) {
  const file = join(out, `${name}-${t}.png`);
  const r = spawnSync(ffmpeg, ["-v", "error", "-y", "-ss", String(t), "-i", webm, "-frames:v", "1", "-vf", "scale=960:-1", file], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`frames: ${t} s failed: ${r.stderr?.trim()}`);
    process.exitCode = 1;
  } else console.log(file);
}
