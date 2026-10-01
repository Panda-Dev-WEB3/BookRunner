// Read models for the HTTP API.
import { bytes32ToStr } from "@bookrunner/shared";
import type { CharterChain } from "../adapters/chain";
import type { CharterRow, CharterStore, VerdictRow } from "../adapters/store";
import { charterToJson } from "../domain/charterJson";
import { cidFromDigest, cidOfJson, digestFromCid } from "../domain/cid";
import type { Verdict } from "../domain/verdict";
import type { VerdictLookup } from "./app";

/** Rows written by the indexer for verdicts posted by someone else carry no content. */
export const isPlaceholderVerdict = (v: unknown): boolean => !!v && typeof v === "object" && (v as Record<string, unknown>).placeholder === true;

function verdictView(r: VerdictRow) {
  const v = r.verdict as Partial<Verdict>;
  return {
    cid: r.cid,
    digest: r.digest,
    recommendApprove: r.recommendApprove,
    postedTx: r.postedTx,
    createdAt: r.createdAt.toISOString(),
    summary: v.summary ?? null,
    tally: v.tally ?? null,
    contentAvailable: !isPlaceholderVerdict(r.verdict),
    url: `/verdicts/${r.cid}`,
  };
}

function charterView(r: CharterRow) {
  return {
    id: r.id,
    source: "db" as const,
    status: r.status,
    sponsor: r.sponsor,
    symbol: r.symbol,
    underlying: r.underlying,
    venue: r.venue,
    charter: r.structJson,
    feeUsd: r.feeUsd,
    bondBkrn: r.bondBkrn,
    filedAt: r.filedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    juryCid: r.juryCid,
    bookAddr: r.bookAddr,
    meta: r.meta,
  };
}

export async function getCharterView(id: number, store: CharterStore | null, chain: CharterChain | null) {
  const row = store ? await store.getCharter(id) : null;
  const verdicts = store ? (await store.verdictsFor(id)).map(verdictView) : [];
  if (row) return { ...charterView(row), verdicts };
  if (!chain) return null;
  const rec = await chain.charterRecord(id);
  if (!rec) return null;
  const posted = !/^0x0{64}$/i.test(rec.juryDigest);
  return {
    id,
    source: "chain" as const,
    status: rec.status,
    sponsor: rec.charter.sponsor.toLowerCase(),
    symbol: bytes32ToStr(rec.charter.symbol),
    underlying: rec.charter.underlying,
    venue: rec.charter.venue,
    charter: charterToJson(rec.charter),
    filedAt: new Date(rec.filedAt * 1000).toISOString(),
    decidedAt: rec.decidedAt ? new Date(rec.decidedAt * 1000).toISOString() : null,
    juryCid: posted ? cidFromDigest(rec.juryDigest) : null,
    bookAddr: /^0x0{40}$/i.test(rec.book) ? null : rec.book.toLowerCase(),
    verdicts,
  };
}

export async function listCharterViews(store: CharterStore | null, status: string | undefined, limit: number) {
  if (!store) return [];
  return (await store.listCharters(status, limit)).map(charterView);
}

/** Content-addressed read: the stored JSON must hash back to the requested CID. */
export async function lookupVerdict(cid: string, store: CharterStore | null): Promise<VerdictLookup> {
  try {
    digestFromCid(cid);
  } catch (e) {
    return { kind: "bad_cid", error: (e as Error).message };
  }
  if (!store) return { kind: "not_found" };
  const row = await store.verdictByCid(cid);
  if (!row || isPlaceholderVerdict(row.verdict)) return { kind: "not_found" };
  const computed = await cidOfJson(row.verdict);
  if (computed.cid !== cid || row.cid !== cid) return { kind: "integrity_error", expected: cid, actual: computed.cid };
  return { kind: "ok", cid, bytes: computed.bytes };
}
