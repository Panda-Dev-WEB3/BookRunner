// Model jury JSON parsing / repair with a fake Anthropic client.
import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { checkCopy } from "@bookrunner/shared";
import { PERSONAS } from "../src/domain/jurors";
import { runRuleChecks } from "../src/domain/ruleChecks";
import { modelCaps } from "../src/jury/modelCaps";
import {
  type AnthropicLike,
  type JuryCallOptions,
  TransientJurorError,
  anthropicJuryCall,
  juryRequestParams,
  modelJurorVote,
  parseJurorOutput,
} from "../src/jury/modelJuror";
import { castVotes } from "../src/jury/pipeline";
import { nvdaCharter, ruleContextFor } from "./fixtures";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Reply = { text: string; stop?: string; model?: string } | Error;

/** Fake client: returns scripted replies in order and records every request. */
function fakeClient(replies: Reply[]) {
  const calls: CreateParams[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        async create(params: CreateParams) {
          calls.push(params);
          const r = replies.shift();
          if (!r) throw new Error("no scripted reply left");
          if (r instanceof Error) throw r;
          return { content: [{ type: "thinking" }, { type: "text", text: r.text }], stop_reason: r.stop ?? "end_turn", model: r.model ?? String(params.model) };
        },
      },
    },
  };
  return { client, calls };
}

const OPTS: JuryCallOptions = { maxTokens: 16000, temperature: 0.2, effort: "medium", fallbacks: true, structuredOutput: true, timeoutMs: 1000 };
const c = nvdaCharter();
const checks = runRuleChecks(c, ruleContextFor(c));
const input = (finalAttempt = false) => ({ charterId: 1, charter: c, ruleChecks: checks, substitute: PERSONAS[0]!, finalAttempt });
const GOOD = JSON.stringify({ vote: "approve", rationale: "Mandate bounds are enforceable on this venue.", risks: ["IF sits at the venue minimum"] });

describe("parseJurorOutput", () => {
  test("strict JSON", () => {
    const r = parseJurorOutput(GOOD);
    expect(r).toEqual({ ok: true, repaired: false, value: { vote: "approve", rationale: "Mandate bounds are enforceable on this venue.", risks: ["IF sits at the venue minimum"] } });
  });

  test("repairs fences, prose, vote aliases, string risks, rationale aliases", () => {
    const r = parseJurorOutput('Here is my vote:\n```json\n{"vote": "Rejected", "reasoning": "Thin junior layer.", "risks": "float caps"}\n```\nThanks.');
    expect(r).toEqual({ ok: true, repaired: true, value: { vote: "reject", rationale: "Thin junior layer.", risks: ["float caps"] } });
    const bare = parseJurorOutput('My answer {"vote":"approve","rationale":"fine"} end');
    expect(bare.ok && bare.value.risks).toEqual([]);
  });

  test("rejects unusable replies with a reason", () => {
    expect(parseJurorOutput("I approve.").ok).toBe(false);
    expect(parseJurorOutput("[1,2]").ok).toBe(false);
    const r = parseJurorOutput('{"vote":"maybe","rationale":"x","risks":[]}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("vote");
  });
});

describe("request shaping per model", () => {
  test("Opus/Sonnet 5.x: no temperature, effort set, structured output, server-side fallbacks", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const p = juryRequestParams({ model, system: "s", user: "u" }, OPTS);
      expect(p.temperature).toBeUndefined();
      expect(p.output_config?.effort).toBe("medium");
      expect(p.output_config?.format?.type).toBe("json_schema");
      expect(p.fallbacks).toBe("default");
      expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
      expect(p.messages).toEqual([{ role: "user", content: "u" }]);
    }
  });

  test("Haiku 4.5: low temperature, no effort, no fallbacks", () => {
    const p = juryRequestParams({ model: "claude-haiku-4-5-20251001", system: "s", user: "u" }, OPTS);
    expect(p.temperature).toBe(0.2);
    expect(p.output_config?.effort).toBeUndefined();
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
  });

  test("capability table", () => {
    expect(modelCaps("claude-opus-5-5")).toEqual({ temperature: false, effort: true, fallbacks: true, structuredOutput: true });
    expect(modelCaps("claude-haiku-4-5-20251001")).toEqual({ temperature: true, effort: false, fallbacks: false, structuredOutput: true });
    expect(modelCaps("claude-opus-4-8").temperature).toBe(false);
    expect(modelCaps("claude-opus-4-8").fallbacks).toBe(false);
  });

  test("fallbacks off and structured output off are honoured", () => {
    const p = juryRequestParams({ model: "claude-opus-5-5", system: "s", user: "u" }, { ...OPTS, fallbacks: false, structuredOutput: false });
    expect(p.fallbacks).toBeUndefined();
    expect(p.output_config).toEqual({ effort: "medium" });
  });
});

describe("modelJurorVote with a fake Anthropic client", () => {
  test("valid JSON on the first call", async () => {
    const f = fakeClient([{ text: GOOD }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-opus-5-5", input());
    expect(v).toEqual({
      model: "claude-opus-5-5",
      source: "anthropic",
      vote: "approve",
      rationale: "Mandate bounds are enforceable on this venue.",
      risks: ["IF sits at the venue minimum"],
    });
    expect(f.calls).toHaveLength(1);
    expect(String(f.calls[0]!.system)).toContain("Reply with only a JSON object");
  });

  test("malformed once -> one repair retry quoting the bad reply", async () => {
    const f = fakeClient([{ text: "I would approve this charter." }, { text: GOOD }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-sonnet-5-5", input());
    expect(v.vote).toBe("approve");
    expect(v.error).toBe("output repaired on retry");
    expect(f.calls).toHaveLength(2);
    const retryUser = f.calls[1]!.messages[0]!.content as string;
    expect(retryUser).toContain("could not be used");
    expect(retryUser).toContain("I would approve this charter.");
  });

  test("malformed twice -> the seat is voted by its rule persona (no third call)", async () => {
    const f = fakeClient([{ text: "nope" }, { text: '{"vote":"perhaps"}' }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-haiku-4-5-20251001", input());
    expect(f.calls).toHaveLength(2);
    expect(v.source).toBe("rules");
    expect(v.model).toBe("claude-haiku-4-5-20251001>rules:conservative");
    expect(v.error).toContain("malformed output after one retry");
  });

  test("refusal -> substitute persona", async () => {
    const f = fakeClient([{ text: "", stop: "refusal" }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-opus-5-5", input());
    expect(v.source).toBe("rules");
    expect(v.error).toContain("declined");
  });

  test("transient API error throws for a later retry, substitutes on the final attempt", async () => {
    const overloaded = () => Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "overloaded" } }, "overloaded", new Headers());
    const f1 = fakeClient([overloaded()]);
    await expect(modelJurorVote(anthropicJuryCall(f1.client, OPTS), "claude-opus-5-5", input(false))).rejects.toBeInstanceOf(TransientJurorError);
    const f2 = fakeClient([overloaded()]);
    const v = await modelJurorVote(anthropicJuryCall(f2.client, OPTS), "claude-opus-5-5", input(true));
    expect(v.source).toBe("rules");
    expect(v.error).toContain("HTTP 529");
  });

  test("non-transient API error (400) substitutes immediately", async () => {
    const f = fakeClient([Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers())]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-opus-5-5", input(false));
    expect(v.source).toBe("rules");
    expect(v.error).toContain("HTTP 400");
  });

  test("banned copy terms in model text are filtered before storage", async () => {
    const f = fakeClient([{ text: JSON.stringify({ vote: "approve", rationale: "Senior is protected with a stable yield.", risks: ["target APY unclear"] }) }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-opus-5-5", input());
    expect(checkCopy([v.rationale, ...v.risks].join("\n"))).toEqual([]);
  });

  test("server-side fallback model is noted on the seat", async () => {
    const f = fakeClient([{ text: GOOD, model: "claude-opus-4-8" }]);
    const v = await modelJurorVote(anthropicJuryCall(f.client, OPTS), "claude-opus-5-5", input());
    expect(v.error).toContain("served by claude-opus-4-8");
  });

  test("castVotes runs one seat per configured model in order", async () => {
    const f = fakeClient([{ text: GOOD }, { text: GOOD.replace("approve", "reject") }, { text: GOOD }]);
    const votes = await castVotes(1, c, checks, {
      jurors: { kind: "models", call: anthropicJuryCall(f.client, OPTS), models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"] },
      now: () => new Date(0),
      finalAttempt: false,
    });
    expect(votes.map((v) => v.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
    expect(new Set(f.calls.map((p) => p.model))).toEqual(new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]));
  });
});
