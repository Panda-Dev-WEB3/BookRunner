// Root copy linter: code is never prose (no false positive on `return (`), user-facing copy still is.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "../packages/shared/src/copy";
import { extractProse } from "./check-copy";

const terms = (src: string, file = "x.tsx") => checkCopy(extractProse(src, file)).map((v) => v.term);

describe("scripts/check-copy.ts extractor", () => {
  test("code keywords and identifiers are not prose", () => {
    const src = `import { target } from "./returns";
export function Card({ ifTargetUsd }: { ifTargetUsd: number }) {
  if (ifTargetUsd === 0) return null;
  const onClick = (e: { target: unknown }) => e.target;
  return (
    <div className="returns-panel" data-kind="yield">
      {ifTargetUsd > 0 ? <span>{ifTargetUsd}</span> : null}
    </div>
  );
}`;
    expect(terms(src)).toEqual([]);
  });

  test("JSX text, string literals and template text are still checked", () => {
    expect(terms(`export const A = () => <p>Guaranteed returns every week</p>;`)).toEqual(["returns", "guaranteed"]);
    expect(terms(`export const label = "Earn a high APY here";`, "x.ts")).toEqual(["APY"]);
    expect(terms("export const t = (n: number) => `Your yield is ${n}`;", "x.ts")).toEqual(["yield"]);
    expect(terms(`export const B = () => <input placeholder="Protected deposit" />;`)).toEqual(["protected"]);
  });
});
