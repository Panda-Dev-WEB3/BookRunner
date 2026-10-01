// Per-model request shaping for the Messages API (as documented for the current model families):
//   - Opus 4.7+/5.x, Sonnet 5.x, Fable/Mythos reject non-default sampling params (temperature) -> omit;
//     depth is controlled with output_config.effort (adaptive thinking is on by default).
//   - Haiku 4.5 (and older) accept temperature and reject `effort` -> low temperature, no effort.
//   - Server-side refusal fallbacks (`fallbacks: "default"`, beta server-side-fallback-2026-07-01)
//     are enabled on the Opus 5.x / Sonnet 5.5 / Fable 5.1 lines (Claude API only).
// VERIFY against the Models API capabilities when adding models to JURY_MODELS.

export interface ModelCaps {
  temperature: boolean;
  effort: boolean;
  fallbacks: boolean;
  structuredOutput: boolean;
}

const NO_SAMPLING = /^claude-(opus-(4-[7-9]|5)|sonnet-5|fable-|mythos-)/;
const EFFORT = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-|mythos-)/;
const FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5-1|mythos-5-1)/;
const STRUCTURED = /^claude-(opus-(4-[1-9]|5)|sonnet-(4-5|4-6|5)|haiku-4-5|fable-|mythos-)/;

export function modelCaps(model: string): ModelCaps {
  return {
    temperature: !NO_SAMPLING.test(model),
    effort: EFFORT.test(model),
    fallbacks: FALLBACKS.test(model),
    structuredOutput: STRUCTURED.test(model),
  };
}
