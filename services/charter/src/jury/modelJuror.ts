// Model juror: one Anthropic Messages API call per seat, strict JSON {vote, rationale, risks}
// validated with zod, one repair retry on malformed output. Permanent failures (refusal, malformed
// twice, 4xx) hand the seat to the matching deterministic persona so the jury still completes;
// transient failures (429 / 5xx / network) throw so the job is retried with backoff.
import Anthropic from "@anthropic-ai/sdk";
import type { Charter } from "@bookrunner/shared";
import { z } from "zod";
import { sanitizeCopy, sanitizeList } from "../domain/copyFilter";
import { type JurorVote, type Persona, ruleJurorVote } from "../domain/jurors";
import type { RuleCheck } from "../domain/ruleChecks";
import { modelCaps } from "./modelCaps";
import { JUROR_JSON_SCHEMA, JURY_SYSTEM_PROMPT, buildJuryUserMessage, buildRepairMessage } from "./prompt";

// ---------------------------------------------------------------- output parsing

export const jurorOutputSchema = z.object({
  vote: z.enum(["approve", "reject"]),
  rationale: z.string().trim().min(1).max(4000),
  risks: z.array(z.string().trim().min(1).max(1000)).max(20),
});
export type JurorOutput = z.infer<typeof jurorOutputSchema>;

export type ParseResult = { ok: true; value: JurorOutput; repaired: boolean } | { ok: false; error: string };

const VOTE_ALIASES: Record<string, "approve" | "reject"> = {
  approve: "approve",
  approved: "approve",
  approval: "approve",
  accept: "approve",
  reject: "reject",
  rejected: "reject",
  rejection: "reject",
  deny: "reject",
  denied: "reject",
};

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Parses a juror reply; tolerates code fences, surrounding prose and common field variants. */
export function parseJurorOutput(text: string): ParseResult {
  const trimmed = text.trim();
  let repaired = false;
  let value = tryJson(trimmed);
  if (value === undefined) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced?.[1]) value = tryJson(fenced[1].trim());
    if (value === undefined) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) value = tryJson(trimmed.slice(start, end + 1));
    }
    if (value === undefined) return { ok: false, error: "reply is not JSON" };
    repaired = true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "reply is not a JSON object" };
  const o = { ...(value as Record<string, unknown>) };
  if (typeof o.vote === "string") {
    const alias = VOTE_ALIASES[o.vote.trim().toLowerCase()];
    if (alias && alias !== o.vote) {
      o.vote = alias;
      repaired = true;
    }
  }
  if (o.rationale === undefined) {
    for (const k of ["reasoning", "reason", "explanation"]) {
      if (typeof o[k] === "string") {
        o.rationale = o[k];
        repaired = true;
        break;
      }
    }
  }
  if (typeof o.risks === "string") {
    o.risks = o.risks ? [o.risks] : [];
    repaired = true;
  } else if (o.risks === undefined) {
    o.risks = [];
    repaired = true;
  }
  const parsed = jurorOutputSchema.safeParse({ vote: o.vote, rationale: o.rationale, risks: o.risks });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data, repaired };
}

// ---------------------------------------------------------------- model client

export interface JuryModelRequest {
  model: string;
  system: string;
  user: string;
}

export interface JuryModelResponse {
  text: string;
  stopReason: string | null;
  servedBy: string;
}

export type JuryModelCall = (req: JuryModelRequest) => Promise<JuryModelResponse>;

/** Structural subset of the Anthropic client used here (lets tests pass a fake client). */
export interface AnthropicLike {
  beta: {
    messages: {
      create(
        params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
        options?: { timeout?: number },
      ): PromiseLike<{ content: ReadonlyArray<{ type: string; text?: string }>; stop_reason: string | null; model: string }>;
    };
  };
}

export interface JuryCallOptions {
  maxTokens: number;
  temperature: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks: boolean;
  structuredOutput: boolean;
  timeoutMs: number;
}

export function juryRequestParams(req: JuryModelRequest, o: JuryCallOptions): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const caps = modelCaps(req.model);
  const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
  if (caps.effort) outputConfig.effort = o.effort;
  if (o.structuredOutput && caps.structuredOutput) outputConfig.format = { type: "json_schema", schema: { ...JUROR_JSON_SCHEMA } };
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: o.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  if (caps.temperature) params.temperature = o.temperature;
  if (o.fallbacks && caps.fallbacks) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

export function anthropicJuryCall(client: AnthropicLike, o: JuryCallOptions): JuryModelCall {
  return async (req) => {
    const res = await client.beta.messages.create(juryRequestParams(req, o), { timeout: o.timeoutMs });
    const text = res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return { text, stopReason: res.stop_reason, servedBy: res.model };
  };
}

export function createAnthropicClient(apiKey: string): AnthropicLike {
  return new Anthropic({ apiKey, maxRetries: 2 }) as unknown as AnthropicLike;
}

// ---------------------------------------------------------------- juror

export class TransientJurorError extends Error {}

/** 408/409/429/5xx and connection errors are worth retrying later; other API errors are not. */
export function isTransientApiError(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    const s = e.status ?? 0;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }
  return false;
}

export interface ModelJurorInput {
  charterId: number;
  charter: Charter;
  ruleChecks: RuleCheck[];
  /** Persona that takes the seat if the model cannot produce a usable vote. */
  substitute: Persona;
  /** On the final job attempt transient errors also hand the seat to the substitute. */
  finalAttempt: boolean;
}

function fromOutput(model: string, out: JurorOutput, servedBy: string, note?: string): JurorVote {
  const rationale = sanitizeCopy(out.rationale.slice(0, 1200)).text;
  const risks = sanitizeList(out.risks.slice(0, 8).map((r) => r.slice(0, 300))).items;
  const v: JurorVote = { model, source: "anthropic", vote: out.vote, rationale, risks };
  const notes = [servedBy && servedBy !== model ? `served by ${servedBy} (server-side fallback)` : "", note ?? ""].filter(Boolean);
  if (notes.length) v.error = notes.join("; ");
  return v;
}

function substituted(input: ModelJurorInput, model: string, why: string): JurorVote {
  const v = ruleJurorVote(input.substitute, input.charter, input.ruleChecks);
  return { ...v, model: `${model}>${input.substitute.id}`, error: `${why}; seat voted by the ${input.substitute.label} rule juror` };
}

export async function modelJurorVote(call: JuryModelCall, model: string, input: ModelJurorInput): Promise<JurorVote> {
  const user = buildJuryUserMessage(input.charterId, input.charter, input.ruleChecks);
  let lastError = "";
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? user : buildRepairMessage(user, lastText, lastError);
    let res: JuryModelResponse;
    try {
      res = await call({ model, system: JURY_SYSTEM_PROMPT, user: content });
    } catch (e) {
      if (isTransientApiError(e) && !input.finalAttempt) throw new TransientJurorError(`${model}: ${(e as Error).message}`);
      const status = e instanceof Anthropic.APIError ? ` (HTTP ${e.status ?? "?"})` : "";
      return substituted(input, model, `model call failed${status}`);
    }
    if (res.stopReason === "refusal") return substituted(input, model, "model declined the request");
    const parsed = parseJurorOutput(res.text);
    if (parsed.ok) return fromOutput(model, parsed.value, res.servedBy, attempt > 0 ? "output repaired on retry" : undefined);
    lastError = res.stopReason === "max_tokens" ? `${parsed.error}; reply was cut off at max_tokens` : parsed.error;
    lastText = res.text;
  }
  return substituted(input, model, `malformed output after one retry (${lastError})`);
}
