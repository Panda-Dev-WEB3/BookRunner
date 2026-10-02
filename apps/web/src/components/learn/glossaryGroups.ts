// Reading groups for the glossary on the How it works page, plus the search filter. Every id in
// lib/glossary.ts belongs to exactly one group (unit-tested); an id added later without a group lands
// in "More terms" so it is never hidden.
import { GLOSSARY, GLOSSARY_IDS, type GlossaryId, isGlossaryId } from "../../lib/glossary";

export interface GlossaryGroup {
  id: string;
  title: string;
  ids: GlossaryId[];
}

export const GLOSSARY_GROUPS: readonly GlossaryGroup[] = [
  {
    id: "product",
    title: "Books and tranches",
    ids: ["book", "charter", "sponsor", "riskCommittee", "allocator", "tranche", "senior", "junior", "subscriptionWindow", "topUpRound", "redemptionNotice"],
  },
  { id: "money", title: "Money and the waterfall", ids: ["feeFlow", "waterfall", "hurdle", "carry", "nav", "sharePrice", "backstop", "insuranceFund"] },
  { id: "proof", title: "Marks and proof", ids: ["mark", "merkleReceipt", "pullOracle"] },
  { id: "trading", title: "Trading and risk", ids: ["perp", "marketMaker", "bookrunnerAgent", "mandate", "hedgeBand", "killSwitch", "drawdown", "stockToken"] },
  { id: "token", title: "The token", ids: ["bkrn", "staking"] },
  { id: "chain", title: "Chain basics", ids: ["wallet", "gas", "usdc", "testnet"] },
];

/** Groups with any ungrouped glossary id appended as "More terms". */
export function glossaryGroups(): GlossaryGroup[] {
  const seen = new Set(GLOSSARY_GROUPS.flatMap((g) => g.ids));
  const rest = GLOSSARY_IDS.filter((id) => !seen.has(id));
  return rest.length ? [...GLOSSARY_GROUPS, { id: "more", title: "More terms", ids: rest }] : [...GLOSSARY_GROUPS];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** True when an entry matches the search text (term name first, then its definitions). Empty matches all. */
export function matchesGlossary(id: GlossaryId, query: string): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  const e = GLOSSARY[id];
  return [e.term, e.short, e.long ?? "", id].some((s) => norm(s).includes(q));
}

/** Groups filtered by the search text; groups left empty are dropped. */
export function filterGroups(groups: readonly GlossaryGroup[], query: string): GlossaryGroup[] {
  return groups.map((g) => ({ ...g, ids: g.ids.filter((id) => matchesGlossary(id, query)) })).filter((g) => g.ids.length > 0);
}

/** Glossary id from a location hash ("#term-senior" -> "senior"), or null. */
export function termFromHash(hash: string): GlossaryId | null {
  let raw = hash;
  try {
    raw = decodeURIComponent(hash);
  } catch {
    return null;
  }
  const id = /^#?term-(.+)$/.exec(raw)?.[1];
  return id && isGlossaryId(id) ? id : null;
}
