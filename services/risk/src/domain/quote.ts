// Which agent quote (KEYS.agentQuote) is "live" and checked for skew/width, and against which
// reference price. Pure.
//
// Rules:
//  - a quote older than maxAgeMs (or implausibly far in the future) is not live → no quote check;
//  - only two-sided quotes have a mid; a one-sided (reduce-only) or empty quote is not checked;
//  - reference = the oracle the agent quoted against (QuoteMsg.oracle), UNLESS that reference itself
//    deviates from the attested oracle by more than maxSkewBps (or is missing) — then the attested
//    price is used, so a bad agent reference cannot hide a skewed quote.
import { type QuoteProposal, quoteSkewBps, quoteWidthBps } from "@bookrunner/shared";
import type { QuoteObservation } from "../types";

const FUTURE_TOLERANCE_MS = 5_000;

export interface QuoteSelection {
  proposal: QuoteProposal | undefined;
  info: { ts: number; ageMs: number; used: boolean; reference: "agent" | "oracle"; widthBps: number; skewBps: number } | null;
}

export function selectLiveQuote(
  q: QuoteObservation | null,
  attestedPx: number | null,
  nowMs: number,
  maxAgeMs: number,
  maxSkewBps: number,
): QuoteSelection {
  if (!q) return { proposal: undefined, info: null };
  const ageMs = nowMs - q.ts;
  const live = ageMs <= maxAgeMs && ageMs >= -FUTURE_TOLERANCE_MS;
  const twoSided = q.sides.bid && q.sides.ask && q.bid > 0 && q.ask > 0;

  let reference: "agent" | "oracle" = "agent";
  let px = q.oracle;
  if (attestedPx !== null && attestedPx > 0) {
    const refDevBps = q.oracle > 0 ? (Math.abs(q.oracle - attestedPx) / attestedPx) * 10_000 : Number.POSITIVE_INFINITY;
    if (refDevBps > maxSkewBps) {
      reference = "oracle";
      px = attestedPx;
    }
  }
  const proposal: QuoteProposal = { bidPx: q.bid, askPx: q.ask, oraclePx: px };
  const used = live && twoSided && px > 0;
  return {
    proposal: used ? proposal : undefined,
    info: {
      ts: q.ts,
      ageMs,
      used,
      reference,
      widthBps: twoSided ? quoteWidthBps(proposal) : 0,
      skewBps: twoSided ? quoteSkewBps(proposal) : 0,
    },
  };
}
