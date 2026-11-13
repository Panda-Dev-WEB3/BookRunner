// /official-links/: the contract tables of apps/site/public/official-links/index.html, generated at build time (vite.config.ts
// officialLinksPage) from the mainnet deployment record contracts/deployments/4663.json when it is present (host-local,
// gitignored: the mainnet host builds the site from its own checkout), else placeholders. The governance Safe and the
// settlement token come from the committed deploy inputs (contracts/deploy-inputs/4663.json), so they show before a
// deployment too. The insurance pool is listed only while the app shows it (apps/web/.env.mainnet VITE_POOL_ENABLED).
//
// The page promises that the app only asks a wallet to sign transactions to the addresses listed, so the tables carry
// every contract the app's prepared-transaction check accepts (apps/web/src/wallet/txVerify.ts useFlowTargets): the
// settlement token, BKRN, staking, the charter registry, the Risk Committee, the oracle, the pool engine, the insurance
// pool, and each book's Senior / Junior tranches and mandate (the mandate is read from the chain by the app; the record
// carries it in the book's components). No inline script is generated (the page's CSP has no hash for one).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAINNET_CHAIN_ID = 4663;
export const EXPLORER = "https://explorer.chain.robinhood.com";
export const MARKER = "<!--@official-links:contracts-->";
export const PENDING = "Published here after the mainnet deployment";

type Addr = string | null | undefined;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;
const valid = (a: Addr): string | null => (typeof a === "string" && ADDRESS.test(a) && !ZERO.test(a) ? a : null);

/** The fields of contracts/deployments/4663.json this page reads (packages/shared Deployment). */
export interface RecordLike {
  chainId?: number;
  contracts?: Partial<Record<"config" | "timelock" | "factory" | "oracle" | "usdc" | "bkrn" | "staking" | "charter" | "committee" | "poolEngine" | "insurancePool", string>>;
  books?: Array<{ bookId: number; name?: string; symbol?: string; components?: Partial<Record<"book" | "senior" | "junior" | "mandate", string>> }>;
}

/** The fields of contracts/deploy-inputs/4663.json this page reads. */
export interface InputsLike {
  governance?: { multisig?: string };
  externals?: { settlementToken?: string; settlementSymbol?: string };
}

export interface LinkRow {
  label: string;
  note?: string;
  address: string | null;
}

export interface OfficialLinks {
  deployed: boolean;
  governance: LinkRow[];
  contracts: LinkRow[];
  books: Array<{ title: string; rows: LinkRow[] }>;
}

export function officialLinks(record: RecordLike | null, inputs: InputsLike | null, opts: { poolEnabled: boolean }): OfficialLinks {
  const rec = record && record.chainId === MAINNET_CHAIN_ID ? record : null;
  const c = rec?.contracts ?? {};
  const sym = inputs?.externals?.settlementSymbol?.trim() || "USDG";
  const governance: LinkRow[] = [
    { label: "Governance Safe (multisig)", note: "owns the timelock; guardian", address: valid(inputs?.governance?.multisig) },
    { label: "Timelock", note: "every protocol change waits here first", address: valid(c.timelock) },
    { label: "Protocol config", note: "BookrunnerConfig", address: valid(c.config) },
    { label: "Book factory", address: valid(c.factory) },
  ];
  const contracts: LinkRow[] = [
    { label: `Settlement token (${sym})`, note: "deposits and payouts", address: valid(c.usdc) ?? valid(inputs?.externals?.settlementToken) },
    { label: "BKRN token", address: valid(c.bkrn) },
    { label: "BKRN staking", address: valid(c.staking) },
    { label: "Market charter registry", note: "charter filings", address: valid(c.charter) },
    { label: "Risk Committee", note: "committee votes", address: valid(c.committee) },
    { label: "Oracle", note: "AttestedOracle: signed prices", address: valid(c.oracle) },
    { label: "Pool engine", note: "in-house perp markets", address: valid(c.poolEngine) },
    ...(opts.poolEnabled ? [{ label: "Insurance pool", address: valid(c.insurancePool) }] : []),
  ];
  const books = (rec?.books ?? [])
    .filter((b) => Number.isSafeInteger(b.bookId))
    .sort((a, b) => a.bookId - b.bookId)
    .map((b) => ({
      title: `Book #${b.bookId}${b.name ? ` ${b.name}` : ""}`,
      rows: [
        { label: "Senior tranche", address: valid(b.components?.senior) },
        { label: "Junior tranche", address: valid(b.components?.junior) },
        { label: "Mandate", address: valid(b.components?.mandate) },
        { label: "Book", address: valid(b.components?.book) },
      ],
    }));
  return { deployed: rec !== null, governance, contracts, books };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function row(r: LinkRow): string {
  const th = `<th scope="row">${esc(r.label)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ""}</th>`;
  if (!r.address) return `<tr>${th}<td class="pending" colspan="2">${PENDING}</td></tr>`;
  const a = esc(r.address);
  return `<tr>${th}<td><code class="addr">${a}</code></td><td><a href="${EXPLORER}/address/${a}" rel="noopener noreferrer">Explorer</a></td></tr>`;
}

function table(id: string, title: string, intro: string, rows: LinkRow[]): string {
  return [
    `<section aria-labelledby="${id}">`,
    `<h2 id="${id}">${esc(title)}</h2>`,
    intro ? `<p>${esc(intro)}</p>` : "",
    `<div class="table-wrap"><table>`,
    `<thead><tr><th scope="col">Contract</th><th scope="col">Address</th><th scope="col">Check</th></tr></thead>`,
    `<tbody>`,
    ...rows.map(row),
    `</tbody>`,
    `</table></div>`,
    `</section>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The template with its marker replaced by the generated tables. */
export function renderOfficialLinks(template: string, links: OfficialLinks): string {
  if (!template.includes(MARKER)) throw new Error(`official-links template has no ${MARKER} marker`);
  const parts = [
    table("governance-title", "Governance on Robinhood Chain", "Who can change the protocol, and the delay every change goes through.", links.governance),
    table("contracts-title", "Contracts the app asks you to sign for", "Your wallet should show one of these addresses on every transaction the app prepares.", links.contracts),
    ...links.books.map((b, i) => table(`book-${i}-title`, b.title, "", b.rows)),
  ];
  if (!links.deployed) parts.push(`<p class="pending">The protocol contracts are being deployed: their addresses appear here as soon as the deployment is recorded. Until then, sign nothing that claims to be BookRunner.</p>`);
  return template.replace(MARKER, parts.join("\n"));
}

const readJson = <T>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

/** The page's data from the repository: the record (when present), the deploy inputs and the app's pool switch. */
export function loadOfficialLinks(repoRoot: string): OfficialLinks {
  const record = readJson<RecordLike>(resolve(repoRoot, "contracts/deployments/4663.json"));
  const inputs = readJson<InputsLike>(resolve(repoRoot, "contracts/deploy-inputs/4663.json"));
  const env = existsSync(resolve(repoRoot, "apps/web/.env.mainnet")) ? readFileSync(resolve(repoRoot, "apps/web/.env.mainnet"), "utf8") : "";
  const poolEnabled = (env.match(/^VITE_POOL_ENABLED=(\S*)$/m)?.[1] ?? "true") !== "false";
  return officialLinks(record, inputs, { poolEnabled });
}
