// Copy rules (Overview §10): the extractor finds prose, skips code positions, and the whole app passes.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { checkSnippets, extractCopy, extractHtmlCopy } from "../scripts/copy-extract";
import { checkApp } from "../scripts/check-copy";
import { AGENTS_LINE, BACKSTOP_LINE, FEE_FLOW_LINE, LEGAL, LIVE_VS_MARKED, NOTICE_LINE, REVENUE_CLAIM_LINE, STRAPLINE, TAGLINE, TESTNET_MOCKS_LINE, TRANCHE_COPY, buybackWhere, venueDetail } from "../src/lib/copy";

describe("extractCopy", () => {
  test("finds JSX text, attributes shown to readers, literals and template text", () => {
    const src = `
      import { x } from "guaranteed-module";
      const a = "Senior yield, risk-free";
      export function P({ y }: { y: number }) {
        return <div className="target-ring" title="Protected tranche" aria-label="ok">
          Earn APY {y} today
          <input placeholder={\`Target \${y}\`} />
        </div>;
      }`;
    const v = checkSnippets(extractCopy(src, "p.tsx"));
    expect(v.map((x) => x.term).sort()).toEqual(["APY", "protected", "risk-free", "target", "yield"]);
    expect(v.find((x) => x.term === "APY")?.line).toBe(6);
  });

  test("skips code positions: imports, property access, keys, class names, comparisons, literal types", () => {
    const src = `
      import t from "./targets";
      type K = "returns" | "target";
      const m = { "target": 1, ifTargetUsd: 2 };
      const n = m["target"];
      const c = cx("target", "returns");
      function f(e: { target: unknown; kind: string }) { if (e.kind === "target") return e.target; }
      const el = <a href="/returns" target="_blank" className="yield">Fee flow</a>;
    `;
    expect(checkSnippets(extractCopy(src, "q.tsx"))).toEqual([]);
  });

  test("HTML: title, meta content and text; scripts ignored", () => {
    const html = `<html><head><title>Bookrunner</title><meta name="description" content="Guaranteed returns" />
      <script>var target = 1; // yield</script></head><body>Run the book.</body></html>`;
    const snippets = extractHtmlCopy(html);
    expect(snippets.some((s) => s.text === "Run the book.")).toBe(true);
    expect(checkSnippets(snippets).map((v) => v.term).sort()).toEqual(["guaranteed", "returns"]);
  });
});

describe("canonical copy", () => {
  test("every canonical line passes the shared rules", () => {
    const lines = [TAGLINE, STRAPLINE, LEGAL, AGENTS_LINE, BACKSTOP_LINE, LIVE_VS_MARKED, FEE_FLOW_LINE, NOTICE_LINE, TRANCHE_COPY.senior.line, TRANCHE_COPY.junior.line, venueDetail("orderly"), venueDetail("pool_engine")];
    for (const l of lines) expect(checkCopy(l)).toEqual([]);
  });
  test("test networks never present protocol-owned mocks as real integrations (Deploy.s.sol)", () => {
    expect(venueDetail("orderly")).toBe("Listed on Orderly's public contracts");
    expect(venueDetail("orderly", true)).not.toContain("public contracts");
    expect(venueDetail("orderly", true)).toContain("testnet simulator");
    expect(venueDetail("pool_engine", true)).toBe(venueDetail("pool_engine"));
    expect(buybackWhere(false)).toBe("on the market");
    expect(buybackWhere(true)).toContain("mock swap router");
    expect(TESTNET_MOCKS_LINE).toContain("Stock Tokens");
    for (const l of [venueDetail("orderly", true), buybackWhere(true), TESTNET_MOCKS_LINE]) expect(checkCopy(l)).toEqual([]);
  });
  test("tranches are described by seniority and loss order; footer is exact", () => {
    expect(TRANCHE_COPY.senior.line).toContain("last loss in the waterfall");
    expect(TRANCHE_COPY.junior.line).toContain("first loss");
    expect(TRANCHE_COPY.junior.line).toContain("Notice is not a gate");
    expect(LEGAL).toBe("Bookrunner is software; not a fund, adviser, broker or venue operator of record. Stock-perp books are not offered to US persons.");
    expect(TAGLINE).toBe("Run the book.");
    // "never a revenue claim" is explained as no claim on book USDC, never as "no fixed rate" (notifyReward does share BKRN)
    expect(REVENUE_CLAIM_LINE).toContain("no claim on any book's USDC or fee flow");
    expect(REVENUE_CLAIM_LINE).toContain("can be zero");
    expect(checkCopy(REVENUE_CLAIM_LINE)).toEqual([]);
  });
});

describe("the whole app", () => {
  test("has no copy violations", () => {
    const r = checkApp();
    expect(r.files).toBeGreaterThan(40);
    expect(r.snippets).toBeGreaterThan(500);
    expect(r.violations).toEqual([]);
  });
});
