// Records the product demo clips: bash scripts/video.sh demo run <1|2|3|4|all>
//   1 site       public site https://bookrunner.tech (no local server, no wallet)
//   2 allocator  local app + demo wallet: mint test USDC, approve + deposit 1,000 test USDC into NVDA Junior (the only
//                clip that sends transactions, on testnet 46630)
//   3 sponsor    local app + demo wallet connected: file-a-charter form up to the prepared filing, never signed
//   4 risk       local app, no wallet: risk, agents, signed marks, proof check, fee-flow waterfall
// Outputs per clip: public/demos/<n>-<id>.webm + .steps.json (recorder.mjs). Each scenario exports its ordered step
// keys; a recording is kept only if every key was logged, in that order (otherwise it is discarded and the run fails).
import { DEFAULT_OUT_DIR, recordScenario, runScenario } from "./recorder.mjs";
import { scenario as site } from "./scenarios/1-site.mjs";
import { scenario as allocator } from "./scenarios/2-allocator.mjs";
import { scenario as sponsor } from "./scenarios/3-sponsor.mjs";
import { scenario as risk } from "./scenarios/4-risk.mjs";

export const SCENARIOS = { 1: site, 2: allocator, 3: sponsor, 4: risk };
const RESERVED = new Set(["__sync", "loaded"]);

/** Wraps a scenario's run so step keys are checked against its declared, ordered list. */
function checkedRun(sc) {
  return async (ctx) => {
    const seen = [];
    const step = (key) => {
      const want = sc.steps[seen.length];
      if (key !== want) throw new Error(`[${sc.name}] step "${key}" logged where "${want ?? "(none: all steps done)"}" was expected`);
      seen.push(key);
      return ctx.step(key);
    };
    await sc.run({ ...ctx, step });
    if (seen.length !== sc.steps.length) throw new Error(`[${sc.name}] only ${seen.length} of ${sc.steps.length} steps logged (missing: ${sc.steps.slice(seen.length).join(", ")})`);
  };
}

async function record(sc) {
  if (sc.steps.some((k) => RESERVED.has(k))) throw new Error(`[${sc.name}] reserved step key in steps`);
  console.log(`\n=== ${sc.name} (${sc.steps.length} steps${sc.wallet ? ", demo wallet" : ""}) ===`);
  const opts = { name: sc.name, wallet: sc.wallet, run: checkedRun(sc), scenarioTimeoutMs: sc.timeoutMs };
  if (sc.baseUrl) {
    // public site: no local app server
    try {
      const res = await recordScenario({ ...opts, baseUrl: sc.baseUrl, outDir: DEFAULT_OUT_DIR });
      console.log(`recorded ${res.webm}`);
      console.log(JSON.stringify(res.steps));
      return res;
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return null;
    }
  }
  return runScenario({ ...opts, path: sc.path ?? "" });
}

const arg = process.argv[2] ?? "";
const picked = arg === "all" ? Object.keys(SCENARIOS) : [arg];
if (!picked.every((k) => k in SCENARIOS)) {
  console.error("usage: bash scripts/video.sh demo run <1|2|3|4|all>");
  process.exit(2);
}
const summary = [];
for (const k of picked) {
  const sc = SCENARIOS[k];
  const res = await record(sc);
  const durS = res ? (res.steps.at(-1).tMs / 1000).toFixed(1) : null;
  summary.push(`${sc.name}: ${res ? `ok, last step at ${durS} s` : "FAILED"}`);
  if (!res) process.exitCode = 1;
}
console.log(`\n${summary.join("\n")}`);
