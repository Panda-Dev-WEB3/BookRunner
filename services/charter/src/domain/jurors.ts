// Deterministic rule-based juror ensemble (used when no ANTHROPIC_API_KEY is configured, so the
// devnet works offline). Three personas with different risk thresholds; same input -> same vote.
import type { Charter } from "@bookrunner/shared";
import type { RuleCheck } from "./ruleChecks";

export type Vote = "approve" | "reject";

export interface JurorVote {
  model: string; // model id, or "rules:<persona>"
  source: "anthropic" | "rules";
  vote: Vote | "abstain";
  rationale: string;
  risks: string[];
  error?: string;
}

export interface Persona {
  id: string;
  label: string;
  /** reject when the number of warn checks exceeds this */
  maxWarnings: number;
  /** reject when killAtDrawdownBps is deeper than this */
  killFloorBps: number;
  /** reject when Senior may exceed this share of capital */
  maxSeniorCapBps: number;
}

export const PERSONAS: readonly Persona[] = [
  { id: "rules:conservative", label: "conservative", maxWarnings: 1, killFloorBps: -1200, maxSeniorCapBps: 7500 },
  { id: "rules:balanced", label: "balanced", maxWarnings: 3, killFloorBps: -2500, maxSeniorCapBps: 8500 },
  { id: "rules:permissive", label: "permissive", maxWarnings: 6, killFloorBps: -5000, maxSeniorCapBps: 9500 },
];

export function ruleJurorVote(p: Persona, charter: Charter, checks: RuleCheck[]): JurorVote {
  const blocks = checks.filter((c) => c.status === "block");
  const warns = checks.filter((c) => c.status === "warn");
  const reasons: string[] = [];
  if (blocks.length) reasons.push(`${blocks.length} blocking check(s): ${blocks.map((b) => b.id).join(", ")}`);
  if (warns.length > p.maxWarnings) reasons.push(`${warns.length} warnings exceed this juror's limit of ${p.maxWarnings}`);
  if (charter.mandate.killAtDrawdownBps < p.killFloorBps) {
    reasons.push(`kill drawdown ${charter.mandate.killAtDrawdownBps} bps is deeper than ${p.killFloorBps} bps`);
  }
  if (charter.seniorCapBps > p.maxSeniorCapBps) reasons.push(`Senior cap ${charter.seniorCapBps} bps above ${p.maxSeniorCapBps} bps`);

  const vote: Vote = reasons.length ? "reject" : "approve";
  const rationale =
    vote === "approve"
      ? `The ${p.label} rule juror approves: no blocking checks, ${warns.length} warning(s) within its limit of ${p.maxWarnings}, kill drawdown and loss layers inside its ranges.`
      : `The ${p.label} rule juror rejects: ${reasons.join("; ")}.`;
  const risks = [...blocks, ...warns].map((c) => `${c.id}: ${c.detail}`);
  return { model: p.id, source: "rules", vote, rationale, risks };
}

export function ruleJury(charter: Charter, checks: RuleCheck[], personas: readonly Persona[] = PERSONAS): JurorVote[] {
  return personas.map((p) => ruleJurorVote(p, charter, checks));
}
