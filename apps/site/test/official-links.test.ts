// /official-links/ (apps/site/public/official-links/index.html + scripts/official-links.ts): contract addresses generated
// from the mainnet deployment record at build time (placeholders without it), the "we never DM you" notice, the pool
// omitted while the app hides it, no inline script, the copy rules, and the page in the sitemap and the footers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkSnippets, extractHtmlCopy } from "../../web/scripts/copy-extract";
import { EXPLORER, MARKER, PENDING, type RecordLike, loadOfficialLinks, officialLinks, renderOfficialLinks } from "../scripts/official-links";

const ROOT = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const template = read("apps/site/public/official-links/index.html");
const inputs = JSON.parse(read("contracts/deploy-inputs/4663.json"));
const SAFE = "0x848c91323f720DEf985adbCC85FA40E3405B70DF";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const record: RecordLike = {
  chainId: 4663,
  contracts: { config: A(1), timelock: A(2), factory: A(3), oracle: A(4), usdc: A(5), bkrn: A(6), staking: A(7), charter: A(8), committee: A(9), poolEngine: A(10), insurancePool: A(11) },
  books: [{ bookId: 1, name: "NVDA <b>", components: { book: A(20), senior: A(21), junior: A(22), mandate: A(23) } }],
};

describe("official links data", () => {
  test("from the record: governance, every contract the app signs for, each book's tranches and mandate", () => {
    const l = officialLinks(record, inputs, { poolEnabled: true });
    expect(l.deployed).toBe(true);
    expect(l.governance.map((r) => [r.label, r.address])).toEqual([
      ["Governance Safe (multisig)", SAFE],
      ["Timelock", A(2)],
      ["Protocol config", A(1)],
      ["Book factory", A(3)],
    ]);
    expect(l.contracts.map((r) => r.address)).toEqual([A(5), A(6), A(7), A(8), A(9), A(4), A(10), A(11)]);
    expect(l.books[0]!.rows.map((r) => r.address)).toEqual([A(21), A(22), A(23), A(20)]);
  });

  test("the insurance pool is omitted while the app hides it (apps/web/.env.mainnet VITE_POOL_ENABLED=false)", () => {
    expect(officialLinks(record, inputs, { poolEnabled: false }).contracts.some((r) => r.label === "Insurance pool")).toBe(false);
    expect(read("apps/web/.env.mainnet")).toMatch(/^VITE_POOL_ENABLED=false$/m);
    expect(loadOfficialLinks(ROOT).contracts.some((r) => r.label === "Insurance pool")).toBe(false);
  });

  test("without a record (or a record of another chain): placeholders, except what the committed deploy inputs know", () => {
    for (const rec of [null, { ...record, chainId: 46630 }]) {
      const l = officialLinks(rec, inputs, { poolEnabled: false });
      expect(l.deployed).toBe(false);
      expect(l.governance[0]!.address).toBe(SAFE);
      expect(l.governance.slice(1).every((r) => r.address === null)).toBe(true);
      // the settlement token is an external contract, known before the deployment
      expect(l.contracts[0]).toMatchObject({ label: "Settlement token (USDG)", address: inputs.externals.settlementToken });
      expect(l.books).toEqual([]);
    }
  });

  test("malformed and zero addresses are never printed", () => {
    const l = officialLinks({ chainId: 4663, contracts: { config: "0x123", timelock: A(0), factory: "javascript:alert(1)" } }, null, { poolEnabled: false });
    expect(l.governance.map((r) => r.address)).toEqual([null, null, null, null]);
  });
});

describe("rendered page", () => {
  const page = renderOfficialLinks(template, officialLinks(record, inputs, { poolEnabled: false }));
  const empty = renderOfficialLinks(template, officialLinks(null, inputs, { poolEnabled: false }));

  test("addresses with explorer links; names escaped; placeholders without a record", () => {
    expect(template).toContain(MARKER);
    expect(page).not.toContain(MARKER);
    expect(page).toContain(`<code class="addr">${A(2)}</code></td><td><a href="${EXPLORER}/address/${A(2)}" rel="noopener noreferrer">Explorer</a>`);
    expect(page).toContain("Book #1 NVDA &lt;b&gt;");
    expect(page).not.toContain(A(11)); // pool off
    expect(empty).toContain(PENDING);
    expect(empty).toContain(SAFE);
  });

  test("site, app, X account, explorer and the notice", () => {
    for (const s of ["https://bookrunner.tech/", "https://bookrunner.tech/app/", "https://x.com/TryBookRunner", "https://explorer.chain.robinhood.com"]) expect(template).toContain(`href="${s}"`);
    expect(template).toContain("We never DM you first");
    expect(template).toContain("We never ask for your seed phrase or private keys");
    expect(template).toContain("The app only asks your wallet to sign transactions to the addresses listed here.");
  });

  test("no inline script, no inline handler (the CSP allows none for this page)", () => {
    for (const html of [template, page, empty]) {
      expect(html).not.toMatch(/<script/i);
      expect(html.match(/<[^>]+\son[a-z]+=["']/gi) ?? []).toEqual([]);
    }
  });

  test("copy rules (banned terms) and no em dash (the site's style)", () => {
    for (const html of [page, empty]) {
      expect(checkSnippets(extractHtmlCopy(html, "official-links/index.html"))).toEqual([]);
      expect(html).not.toContain("—");
    }
  });
});

describe("linked from the site", () => {
  test("sitemap, Framer footers (brand.js), rulebook footer, status header, desk sidebar, operator app footer", () => {
    expect(read("apps/site/public/sitemap.xml")).toContain("<loc>https://bookrunner.tech/official-links/</loc>");
    expect(read("apps/site/public/brand.js")).toContain("official.href='/official-links/'");
    expect(read("apps/site/public/documents/index.html")).toMatch(/<footer class="folio-footer">.*href="\/official-links\/"/);
    expect(read("apps/site/public/status/index.html")).toContain('<a href="/official-links/">Official links</a>');
    expect(read("apps/site/src/dashboard/main.ts")).toContain('<a href="/official-links/">Official links ↗</a>');
    expect(read("apps/web/src/lib/guardedLaunch.ts")).toContain('OFFICIAL_LINKS_URL = "/official-links/"');
  });

  test("the build fills the page (vite.config.ts officialLinksPage)", () => {
    const vite = read("apps/site/vite.config.ts");
    expect(vite).toContain("plugins: [staticTree(), versionedBundle(), officialLinksPage()]");
    expect(vite).toContain('join(root, "dist", "official-links", "index.html")');
  });
});
