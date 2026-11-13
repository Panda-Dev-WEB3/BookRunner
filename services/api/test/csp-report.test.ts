// POST /csp-report (nginx /csp-report, deploy/server): both report formats, the 16 KB cap, sanitized fields only (origin
// of the blocked resource, directive name, document path), counted per 5-minute bucket under bkrn:<ns>:csp:reports:*.
import { describe, expect, test } from "bun:test";
import { CSP_REPORT_MAX_FIELDS, CSP_REPORT_OVERFLOW_FIELD, cspBucket, parseCspField } from "@bookrunner/shared/cspReports";
import { busNames } from "@bookrunner/shared/queues";
import { ROUTE_HEADER, createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { CSP_COUNT_SCRIPT, CSP_REPORT_MAX_BYTES, MemoryCspReportSink, RedisCspReportSink, blockedOrigin, directiveName, documentPath, parseCspReports } from "../src/cspReport";
import { makeWorld } from "./fixtures";

const NOW = Date.UTC(2026, 10, 13, 12, 3, 0);

function app(sink = new MemoryCspReportSink()) {
  const w = makeWorld();
  w.deps.now = () => NOW;
  w.deps.cspReports = sink;
  return { app: createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") }), sink };
}

const post = (body: string, type: string, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:4400/csp-report", { method: "POST", body, headers: { "content-type": type, [ROUTE_HEADER]: "/csp-report", ...headers } });

const reportUri = {
  "csp-report": {
    "document-uri": "https://bookrunner.tech/app/books/1?wallet=0xabc&token=secret#frag",
    referrer: "https://bookrunner.tech/",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; ...",
    "blocked-uri": "https://evil.example:8443/x.js?session=1",
    "status-code": 200,
    "source-file": "https://bookrunner.tech/app/assets/index.js",
  },
};

const reportTo = [
  { type: "csp-violation", age: 10, url: "https://bookrunner.tech/", user_agent: "UA", body: { documentURL: "https://bookrunner.tech/?utm=x", blockedURL: "https://framer.com/edit/init.mjs", effectiveDirective: "script-src-elem", disposition: "enforce" } },
  { type: "csp-violation", body: { documentURL: "https://bookrunner.tech/dashboard/", blockedURL: "inline", effectiveDirective: "script-src-elem", sourceFile: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js" } },
  { type: "deprecation", body: { id: "x" } },
];

describe("sanitizers", () => {
  test("blocked: origin only; schemes and CSP keywords kept as such", () => {
    expect(blockedOrigin("https://evil.example:8443/x.js?session=1#f")).toBe("https://evil.example:8443");
    expect(blockedOrigin("wss://relay.walletconnect.org/socket")).toBe("wss://relay.walletconnect.org");
    expect(blockedOrigin("chrome-extension://abcdef/inpage.js")).toBe("chrome-extension:");
    expect(blockedOrigin("moz-extension")).toBe("moz-extension:");
    expect(blockedOrigin("data:text/javascript,alert(1)")).toBe("data:");
    expect(blockedOrigin("inline")).toBe("inline");
    expect(blockedOrigin("eval")).toBe("eval");
    expect(blockedOrigin("")).toBe("other");
    expect(blockedOrigin(42)).toBe("other");
    expect(blockedOrigin("not a url | with pipes")).toBe("other");
  });

  test("directive: the name only", () => {
    expect(directiveName("script-src-elem")).toBe("script-src-elem");
    expect(directiveName("script-src 'self' https://x")).toBe("script-src");
    expect(directiveName("Bad|Directive")).toBe("other");
    expect(directiveName(undefined)).toBe("other");
  });

  test("document: the path only, never the query or fragment", () => {
    expect(documentPath("https://bookrunner.tech/app/books/1?wallet=0xabc#f")).toBe("/app/books/1");
    expect(documentPath("/research/?q=1")).toBe("/research/");
    expect(documentPath("about:blank")).toBe("/");
    expect(documentPath("https://bookrunner.tech/a|b c")).toBe("/a_b%20c"); // the URL parser encodes the space; no pipe survives
    expect(documentPath("https://bookrunner.tech/" + "x".repeat(500)).length).toBe(120);
  });

  test("both wire formats; report-to keeps csp-violation entries only; an extension's own script is attributed to it", () => {
    expect(parseCspReports("application/csp-report", JSON.stringify(reportUri))).toEqual([{ blocked: "https://evil.example:8443", directive: "script-src-elem", path: "/app/books/1" }]);
    expect(parseCspReports("application/reports+json", JSON.stringify(reportTo))).toEqual([
      { blocked: "https://framer.com", directive: "script-src-elem", path: "/" },
      { blocked: "chrome-extension:", directive: "script-src-elem", path: "/dashboard/" },
    ]);
    expect(parseCspReports("application/csp-report", "{")).toBeNull();
    expect(parseCspReports("application/csp-report", "[]")).toBeNull();
    expect(parseCspReports("application/reports+json", "{}")).toBeNull();
  });
});

describe("POST /csp-report", () => {
  test("counts a report-uri report in the current bucket, with sanitized fields only", async () => {
    const { app: a, sink } = app();
    const res = await a.fetch(post(JSON.stringify(reportUri), "application/csp-report"));
    expect(res.status).toBe(204);
    const bucket = sink.buckets.get(cspBucket(NOW))!;
    expect([...bucket.entries()]).toEqual([["https://evil.example:8443|script-src-elem|/app/books/1", 1]]);
    const stored = [...bucket.keys()].join(" ");
    for (const leak of ["wallet", "token", "secret", "frag", "session", "UA", "original-policy", "127.0.0.1"]) expect(stored).not.toContain(leak);
  });

  test("counts a report-to batch (content type with parameters)", async () => {
    const { app: a, sink } = app();
    const res = await a.fetch(post(JSON.stringify(reportTo), "application/reports+json; charset=utf-8"));
    expect(res.status).toBe(204);
    expect([...sink.buckets.get(cspBucket(NOW))!.keys()].map(parseCspField)).toEqual([
      { blocked: "https://framer.com", directive: "script-src-elem", path: "/" },
      { blocked: "chrome-extension:", directive: "script-src-elem", path: "/dashboard/" },
    ]);
  });

  test("refuses other content types, oversized bodies and malformed reports", async () => {
    const { app: a, sink } = app();
    expect((await a.fetch(post(JSON.stringify(reportUri), "application/json"))).status).toBe(415);
    expect((await a.fetch(post(JSON.stringify(reportUri), "text/plain"))).status).toBe(415);
    const big = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(CSP_REPORT_MAX_BYTES) } });
    expect((await a.fetch(post(big, "application/csp-report"))).status).toBe(413);
    expect((await a.fetch(post("{", "application/csp-report"))).status).toBe(400);
    expect(sink.buckets.size).toBe(0);
  });

  test("only POST, only at the stamped location", async () => {
    const { app: a } = app();
    expect((await a.fetch(new Request("http://127.0.0.1:4400/csp-report", { headers: { [ROUTE_HEADER]: "/csp-report" } }))).status).toBe(404);
    // nginx stamps /csp-report: no other path is reachable through it
    const other = new Request("http://127.0.0.1:4400/v1/books", { method: "POST", body: "{}", headers: { "content-type": "application/csp-report", [ROUTE_HEADER]: "/csp-report" } });
    expect((await a.fetch(other)).status).toBe(400);
  });

  test("a flood of distinct fields is capped per bucket (overflow field)", async () => {
    const sink = new MemoryCspReportSink();
    const many = Array.from({ length: CSP_REPORT_MAX_FIELDS + 5 }, (_, i) => ({ blocked: "inline", directive: "script-src", path: `/p${i}` }));
    await sink.record(many, NOW);
    const h = sink.buckets.get(cspBucket(NOW))!;
    expect(h.size).toBe(CSP_REPORT_MAX_FIELDS + 1);
    expect(h.get(CSP_REPORT_OVERFLOW_FIELD)).toBe(5);
  });
});

describe("Redis sink", () => {
  test("one EVAL per request on the namespaced bucket key, with TTL, field cap and the fields", async () => {
    const calls: unknown[][] = [];
    const key = busNames("mainnet").KEYS.cspReports;
    const sink = new RedisCspReportSink({ eval: async (...a) => void calls.push(a) }, key);
    await sink.record([{ blocked: "inline", directive: "script-src", path: "/" }], NOW);
    await sink.record([], NOW);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([CSP_COUNT_SCRIPT, 1, `bkrn:mainnet:csp:reports:${cspBucket(NOW)}`, 7200, CSP_REPORT_MAX_FIELDS, CSP_REPORT_OVERFLOW_FIELD, "inline|script-src|/"]);
  });

  test("a Redis failure is reported, never thrown", async () => {
    const errors: unknown[] = [];
    const sink = new RedisCspReportSink({ eval: async () => Promise.reject(new Error("down")) }, (b) => `k:${b}`, (e) => errors.push(e));
    await sink.record([{ blocked: "inline", directive: "script-src", path: "/" }], NOW);
    expect(errors.length).toBe(1);
  });
});
