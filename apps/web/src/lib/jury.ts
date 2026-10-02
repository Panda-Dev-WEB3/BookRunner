// Tolerant reader for the jury verdict JSON (services/charter Verdict, content-addressed by CID).

export type JurorVote = "approve" | "reject" | "abstain";

export interface JurorView {
  model: string;
  source: string;
  vote: JurorVote;
  rationale: string;
  risks: string[];
  error: string | null;
}

export interface RuleCheckView {
  id: string;
  status: "pass" | "info" | "warn" | "block";
  detail: string;
  metrics: Record<string, string>;
}

export interface VerdictView {
  models: JurorView[];
  ruleChecks: RuleCheckView[];
  summary: string | null;
  approvalsRequired: number | null;
  tally: { seats: number; approve: number; reject: number; abstain: number } | null;
  createdAt: string | null;
  /** The deployment holds only the CID / digest (e.g. indexed from chain), not the verdict body. */
  placeholder: boolean;
  note: string | null;
}

/** Committee seats are 0-based on-chain; shown 1-based ("Seat 1"). */
export const seatLabel = (seat: number | null | undefined): string => (seat == null ? "Seat ?" : `Seat ${seat + 1}`);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseVerdict(raw: unknown): VerdictView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = rec(raw);
  const models = arr(o.models).map((m): JurorView => {
    const x = rec(m);
    const vote = x.vote === "approve" || x.vote === "reject" ? x.vote : "abstain";
    return {
      model: str(x.model) || "unnamed juror",
      source: str(x.source),
      vote,
      rationale: str(x.rationale),
      risks: arr(x.risks).map(String),
      error: typeof x.error === "string" ? x.error : null,
    };
  });
  const ruleChecks = arr(o.ruleChecks ?? o.rule_checks).map((c): RuleCheckView => {
    const x = rec(c);
    const st = x.status === "pass" || x.status === "info" || x.status === "warn" || x.status === "block" ? x.status : "info";
    return {
      id: str(x.id) || "check",
      status: st,
      detail: str(x.detail),
      metrics: Object.fromEntries(Object.entries(rec(x.metrics)).map(([k, v]) => [k, String(v)])),
    };
  });
  const t = rec(o.tally);
  const tally =
    typeof t.seats === "number" ? { seats: t.seats, approve: Number(t.approve ?? 0), reject: Number(t.reject ?? 0), abstain: Number(t.abstain ?? 0) } : null;
  return {
    models,
    ruleChecks,
    summary: typeof o.summary === "string" ? o.summary : null,
    approvalsRequired: typeof o.approvalsRequired === "number" ? o.approvalsRequired : null,
    tally,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : null,
    placeholder: o.placeholder === true || (models.length === 0 && ruleChecks.length === 0),
    note: typeof o.note === "string" ? o.note : null,
  };
}

/** Human label for a juror id ("rules:conservative" -> "Rule juror: conservative"). */
export function jurorLabel(model: string): string {
  if (model.startsWith("rules:")) return `Rule juror: ${model.slice(6)}`;
  return model;
}
