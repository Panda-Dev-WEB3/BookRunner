// Event handlers: decoded log -> idempotent DB writes + domain events. Keyed "<kind>.<EventName>";
// Senior and Junior share the tranche handlers. Events not listed are tolerated (debug log only).
import type { BookComponents, Deployment, DomainEventPayloads, Logger } from "@bookrunner/shared";
import type { Address } from "viem";
import type { IndexerChain } from "./chain";
import { arg, cidFromDigest, revenueSourceName, symbolStr, usdDb, wadToNumber } from "./convert";
import type { DecodedLog } from "./decode";
import type { IndexerStore, PendingEvent } from "./store";
import type { WatchSet } from "./watch";

export interface HandlerCtx {
  log: DecodedLog;
  ts: Date; // block timestamp
  store: IndexerStore;
  chain: IndexerChain;
  watch: WatchSet;
  deployment: Pick<Deployment, "books">;
  /** every decoded log of the range (sibling lookups within a tx) */
  batch: readonly DecodedLog[];
  emit(e: PendingEvent): Promise<void>;
  logger: Logger;
}

export type Handler = (ctx: HandlerCtx) => Promise<void>;

/** Shared (webhook + internal) event types: payload checked against DomainEventPayloads. */
export function domainEvent<T extends keyof DomainEventPayloads>(type: T, bookId: number, dedupeKey: string, payload: DomainEventPayloads[T]): PendingEvent {
  return { type, bookId, dedupeKey, payload: payload as unknown as Record<string, unknown> };
}

const trancheOf = (l: DecodedLog): "senior" | "junior" => (l.kind === "junior" ? "junior" : "senior");
const requireBook = (l: DecodedLog): number => {
  if (l.bookId === null) throw new Error(`${l.kind}.${l.eventName} without a book id`);
  return l.bookId;
};
const nonZeroAddr = (a: string) => !/^0x0{40}$/i.test(a);

/** BookComponents from the BookCreated tuple. */
export function componentsFromArgs(args: Record<string, unknown>): BookComponents {
  const c = arg.obj(args, "components");
  const pick = (k: keyof BookComponents) => arg.addr(c, k);
  return {
    book: pick("book"),
    senior: pick("senior"),
    junior: pick("junior"),
    vault: pick("vault"),
    mandate: pick("mandate"),
    router: pick("router"),
    desk: pick("desk"),
    adapter: pick("adapter"),
  };
}

// ---------------------------------------------------------------- MarketCharter

const charterFiled: Handler = async ({ log, ts, store, chain, emit }) => {
  const id = arg.big(log.args, "id");
  const rec = await chain.charterRecord(id, log.blockNumber);
  if (!rec) throw new Error(`MarketCharter.get(${id}) unavailable`);
  const symbol = symbolStr(arg.hex(log.args, "symbol"));
  const sponsor = arg.addr(log.args, "sponsor");
  await store.upsertCharterFiled({
    id: Number(id),
    sponsor,
    structJson: rec.charter,
    underlying: arg.hex(log.args, "underlying"),
    symbol,
    venue: arg.num(log.args, "venue"),
    feeUsd: usdDb(arg.big(log.args, "feeUsd")),
    bondBkrn: arg.big(log.args, "bondBkrn").toString(),
    filedAt: rec.filedAt ? new Date(rec.filedAt * 1000) : ts,
    bondTx: log.txHash,
  });
  await emit(domainEvent("charter.filed", Number(id), `charter.filed:${id}`, { charterId: Number(id), sponsor, symbol }));
};

const charterDecided: Handler = async ({ log, ts, store, emit }) => {
  const id = arg.num(log.args, "id");
  const approved = arg.bool(log.args, "approved");
  const juryCid = cidFromDigest(arg.hex(log.args, "juryCid"));
  const book = arg.addr(log.args, "book");
  await store.setCharterStatus(id, approved ? "Approved" : "Rejected", {
    decidedAt: ts,
    juryCid: juryCid || undefined,
    bookAddr: nonZeroAddr(book) ? book : undefined,
    from: ["None", "Filed"],
  });
  const payload: DomainEventPayloads["charter.decided"] = { charterId: id, approved, juryCid, txHash: log.txHash };
  if (nonZeroAddr(book)) payload.book = book;
  await emit(domainEvent("charter.decided", id, `charter.decided:${id}`, payload));
};

const charterExpired: Handler = async ({ log, ts, store }) => {
  await store.setCharterStatus(arg.num(log.args, "id"), "Expired", { decidedAt: ts, from: ["None", "Filed"] });
};

const charterRetired: Handler = async ({ log, store }) => {
  await store.setCharterStatus(arg.num(log.args, "id"), "Retired", { from: ["Approved"] });
};

const sponsorSlashed: Handler = async ({ log, ts, store }) => {
  await store.appendCharterSlash(arg.num(log.args, "id"), {
    sponsor: arg.addr(log.args, "sponsor"),
    amount: arg.big(log.args, "amount").toString(),
    reason: symbolStr(arg.hex(log.args, "reason")),
    tx: log.txHash,
    logIndex: log.logIndex,
    ts: ts.toISOString(),
  });
};

// ---------------------------------------------------------------- RiskCommittee

const juryVerdictPosted: Handler = async ({ log, store }) => {
  const charterId = arg.num(log.args, "charterId");
  const digest = arg.hex(log.args, "cid");
  const cid = cidFromDigest(digest);
  await store.recordVerdictPosted({ charterId, digest, cid, recommendApprove: arg.bool(log.args, "recommendApprove"), txHash: log.txHash });
  if (cid) await store.setCharterJuryCid(charterId, cid);
};

const voted: Handler = async ({ log, ts, store }) => {
  await store.appendCommitteeVote(arg.addr(log.args, "member"), {
    charterId: arg.num(log.args, "charterId"),
    approve: arg.bool(log.args, "approve"),
    tx: log.txHash,
    logIndex: log.logIndex,
    ts: ts.toISOString(),
  });
};

const memberSet: Handler = async ({ log, store }) => {
  const seat = arg.num(log.args, "index");
  const member = arg.addr(log.args, "member");
  if (nonZeroAddr(member)) await store.setCommitteeSeat(member, seat);
  else await store.clearCommitteeSeat(seat);
};

const memberBonded: Handler = async ({ log, store }) => {
  await store.setCommitteeBond(arg.addr(log.args, "member"), arg.big(log.args, "amount"));
};

const memberSlashed: Handler = async ({ log, store }) => {
  await store.reduceCommitteeBond(arg.addr(log.args, "member"), arg.big(log.args, "amount"));
};

// ---------------------------------------------------------------- BookFactory

const bookCreated: Handler = async ({ log, ts, store, chain, watch, deployment, emit }) => {
  const bookId = arg.num(log.args, "bookId");
  const comps = componentsFromArgs(log.args);
  watch.addBook(bookId, comps);
  const charter = (await chain.bookCharter(comps.book, log.blockNumber)) ?? (await store.getCharterStruct(bookId));
  if (!charter) throw new Error(`charter struct for book ${bookId} unavailable`);
  const ends = await chain.bookSubscriptionEnds(comps.book, log.blockNumber);
  const symbol = symbolStr(String(charter.symbol ?? "0x") as `0x${string}`);
  await store.upsertBook({
    id: bookId,
    charterId: bookId,
    bookAddr: comps.book,
    seniorAddr: comps.senior,
    juniorAddr: comps.junior,
    vaultAddr: comps.vault,
    mandateAddr: comps.mandate,
    routerAddr: comps.router,
    deskAddr: comps.desk,
    adapterAddr: comps.adapter,
    venue: Number(charter.venue ?? 0),
    symbol,
    underlying: String(charter.underlying ?? "").toLowerCase(),
    name: deployment.books.find((b) => b.bookId === bookId)?.name ?? null,
    createdAt: ts,
    subscriptionEnds: ends ? new Date(ends * 1000) : null,
  });
  await store.setCharterBook(bookId, comps.book);
  await emit(domainEvent("book.created", bookId, `book.created:${bookId}`, { bookId, book: comps.book }));
};

// ---------------------------------------------------------------- MarkRegistry

const markCommitted: Handler = async ({ log, ts, store, chain }) => {
  const markId = arg.big(log.args, "markId");
  const m = await chain.mark(markId, log.blockNumber);
  const signature = (await chain.commitSignature(log.txHash)) ?? "";
  await store.insertMarkIfAbsent({
    id: Number(markId),
    bookId: arg.num(log.args, "bookId"),
    periodEnd: new Date(arg.num(log.args, "periodEnd") * 1000),
    navUsd: usdDb(arg.big(log.args, "navUsd")),
    deployedValueUsd: usdDb(arg.big(log.args, "deployedValueUsd")),
    inventoryRoot: arg.hex(log.args, "inventoryRoot"),
    pnlJsonHash: arg.hex(log.args, "pnlJsonHash"),
    receiptsRoot: arg.hex(log.args, "receiptsRoot"),
    flowNonce: Number(m?.flowNonce ?? 0n),
    signer: arg.addr(log.args, "signer"),
    signature,
    txHash: log.txHash,
    committedAt: m?.committedAt ? new Date(m.committedAt * 1000) : ts,
  });
};

const registryMarkApplied: Handler = async ({ log, store }) => {
  await store.setMarkApplied(arg.num(log.args, "markId"), log.txHash);
};

// ---------------------------------------------------------------- Book

const windowClosed: Handler = async ({ log, store, emit }) => {
  const bookId = requireBook(log);
  const s = arg.big(log.args, "seniorAllocated");
  const j = arg.big(log.args, "juniorAllocated");
  await store.updateBook(bookId, { state: "Live", seniorNav: usdDb(s), juniorNav: usdDb(j), navUsd: usdDb(s + j) });
  await emit(domainEvent("book.window_closed", bookId, `book.window_closed:${bookId}`, { bookId, seniorAllocated: usdDb(s), juniorAllocated: usdDb(j) }));
  await emit(domainEvent("book.live", bookId, `book.live:${bookId}`, { bookId }));
};

const bookCancelled: Handler = async ({ log, store, emit }) => {
  const bookId = requireBook(log);
  const reason = symbolStr(arg.hex(log.args, "reason"));
  await store.updateBook(bookId, { state: "Cancelled" });
  await emit({ type: "book.cancelled", bookId, dedupeKey: `book.cancelled:${bookId}`, payload: { bookId, reason } });
};

const bookMarkApplied: Handler = async ({ log, store }) => {
  const bookId = requireBook(log);
  const markId = arg.num(log.args, "markId");
  const seniorNav = usdDb(arg.big(log.args, "seniorNav"));
  const juniorNav = usdDb(arg.big(log.args, "juniorNav"));
  await store.updateBook(bookId, { navUsd: usdDb(arg.big(log.args, "navUsd")), seniorNav, juniorNav, lastMarkId: markId });
  await store.setMarkApplied(markId, log.txHash, {
    seniorNav,
    juniorNav,
    seniorPrice: wadToNumber(arg.big(log.args, "seniorPrice")),
    juniorPrice: wadToNumber(arg.big(log.args, "juniorPrice")),
    pnlUsd: usdDb(arg.big(log.args, "pnlUsd")),
  });
};

const lossAbsorbed: Handler = async ({ log, emit }) => {
  const bookId = requireBook(log);
  await emit({
    type: "book.loss_absorbed",
    bookId,
    dedupeKey: `book.loss_absorbed:${log.txHash}:${log.logIndex}`,
    payload: {
      bookId,
      juniorLoss: usdDb(arg.big(log.args, "juniorLoss")),
      seniorLoss: usdDb(arg.big(log.args, "seniorLoss")),
      backstopCovered: usdDb(arg.big(log.args, "backstopCovered")),
      txHash: log.txHash,
    },
  });
};

const retiring: Handler = async ({ log, store, emit }) => {
  const bookId = requireBook(log);
  await store.updateBook(bookId, { state: "Retiring" });
  await emit({ type: "book.retiring", bookId, dedupeKey: `book.retiring:${bookId}`, payload: { bookId } });
};

const retired: Handler = async ({ log, store, emit }) => {
  const bookId = requireBook(log);
  const finalNav = usdDb(arg.big(log.args, "finalNav"));
  await store.updateBook(bookId, { state: "Retired", navUsd: finalNav });
  await emit(domainEvent("book.retired", bookId, `book.retired:${bookId}`, { bookId, finalNav }));
};

const killed: Handler = async ({ log, emit }) => {
  const bookId = requireBook(log);
  await emit({
    type: "book.killed",
    bookId,
    dedupeKey: `book.killed:${bookId}:${log.txHash}`,
    payload: { bookId, reason: symbolStr(arg.hex(log.args, "reason")), txHash: log.txHash },
  });
};

const sponsorBelowSkin: Handler = async ({ log, emit }) => {
  const bookId = requireBook(log);
  await emit({
    type: "sponsor.below_skin",
    bookId,
    dedupeKey: `sponsor.below_skin:${log.txHash}:${log.logIndex}`,
    payload: { bookId, sponsorShares: usdDb(arg.big(log.args, "sponsorShares")), juniorSupply: usdDb(arg.big(log.args, "juniorSupply")), txHash: log.txHash },
  });
};

// ---------------------------------------------------------------- Tranche (Senior / Junior)

const committed: Handler = async ({ log, ts, store }) => {
  await store.insertSubscription({
    bookId: requireBook(log),
    tranche: trancheOf(log),
    wallet: arg.addr(log.args, "receiver"),
    shares: "0",
    assets: usdDb(arg.big(log.args, "assets")),
    ts,
    kind: "commit",
    round: arg.num(log.args, "round"),
    txHash: log.txHash,
    logIndex: log.logIndex,
  });
};

const allocationClaimed: Handler = async ({ log, ts, store }) => {
  const bookId = requireBook(log);
  const shares = arg.big(log.args, "shares");
  const refund = arg.big(log.args, "refund");
  const state = shares === 0n ? await store.getBookState(bookId) : null;
  await store.insertSubscription({
    bookId,
    tranche: trancheOf(log),
    wallet: arg.addr(log.args, "wallet"),
    shares: usdDb(shares),
    assets: usdDb(refund), // refunded USDC on allocation/refund rows
    ts,
    kind: shares > 0n ? "allocation" : state === "Cancelled" ? "cancelled_refund" : "refund",
    round: 0,
    txHash: log.txHash,
    logIndex: log.logIndex,
  });
};

const redeemRequest: Handler = async ({ log, ts, store, emit }) => {
  const bookId = requireBook(log);
  const tranche = trancheOf(log);
  const shares = usdDb(arg.big(log.args, "shares"));
  const wallet = arg.addr(log.args, "controller");
  const requestId = arg.big(log.args, "requestId").toString();
  let notice = 0;
  if (tranche === "junior") {
    const charter = await store.getCharterStruct(bookId);
    notice = Number(charter?.juniorNoticeSeconds ?? 0);
  }
  await store.insertRedemption({
    bookId,
    tranche,
    wallet,
    shares,
    noticeAt: ts,
    requestId,
    eligibleAt: new Date(ts.getTime() + notice * 1000),
    requestTx: log.txHash,
    logIndex: log.logIndex,
  });
  // emitted on every application; the dedupe key makes replays no-ops
  await emit(domainEvent("redemption.requested", bookId, `redemption.requested:${log.txHash}:${log.logIndex}`, { bookId, tranche, wallet, shares, requestId }));
};

/** markId of the Book.MarkApplied in the same tx (bucket settlement happens inside applyMark). */
function siblingMarkId(ctx: HandlerCtx): number | null {
  const m = ctx.batch.find((l) => l.txHash === ctx.log.txHash && l.kind === "book" && l.eventName === "MarkApplied" && l.bookId === ctx.log.bookId);
  return m ? Number(m.args.markId as bigint) : null;
}

const bucketSettled: Handler = async (ctx) => {
  const { log, store, chain, watch, emit } = ctx;
  const bookId = requireBook(log);
  const tranche = trancheOf(log);
  const requestId = arg.big(log.args, "requestId").toString();
  let markId = siblingMarkId(ctx);
  if (markId === null) {
    const book = watch.components(bookId)?.book;
    const last = book ? await chain.bookLastMarkId(book as Address, log.blockNumber) : null;
    markId = last && last > 0n ? Number(last) : null;
  }
  await store.settleRedemptions({ bookId, tranche, requestId, priceWad: arg.big(log.args, "priceWad"), markId });
  await emit(
    domainEvent("redemption.honoured", bookId, `redemption.honoured:${bookId}:${tranche}:${requestId}`, {
      bookId,
      markId: markId ?? 0,
      tranche,
      shares: usdDb(arg.big(log.args, "shares")),
      assets: usdDb(arg.big(log.args, "assets")),
    }),
  );
};

const redemptionClaimed: Handler = async ({ log, ts, store }) => {
  await store.claimRedemptions({ bookId: requireBook(log), tranche: trancheOf(log), wallet: arg.addr(log.args, "controller"), at: ts });
};

// ---------------------------------------------------------------- RevenueRouter

const distributed: Handler = async ({ log, ts, store }) => {
  const a = arg.bigs(log.args, "amounts");
  if (a.length !== 5) throw new Error(`Distributed.amounts has ${a.length} entries`);
  const [gross, expenses, carry, senior, junior] = a as [bigint, bigint, bigint, bigint, bigint];
  await store.insertSettlement({
    bookId: arg.num(log.args, "bookId"),
    ts,
    source: "distribution",
    grossUsd: usdDb(gross),
    expensesUsd: usdDb(expenses),
    carryUsd: usdDb(carry),
    seniorUsd: usdDb(senior),
    juniorUsd: usdDb(junior),
    period: arg.num(log.args, "period"),
    txHash: log.txHash,
    logIndex: log.logIndex,
  });
};

const settlementReceived: Handler = async ({ log, ts, store }) => {
  await store.insertSettlement({
    bookId: arg.num(log.args, "bookId"),
    ts,
    source: revenueSourceName(arg.num(log.args, "source")),
    grossUsd: usdDb(arg.big(log.args, "amount")),
    expensesUsd: "0",
    carryUsd: "0",
    seniorUsd: "0",
    juniorUsd: "0",
    period: null,
    txHash: log.txHash,
    logIndex: log.logIndex,
  });
};

// ---------------------------------------------------------------- MMMandate

const keyRegistered: Handler = async ({ log, store, emit }) => {
  const bookId = requireBook(log);
  const key = arg.addr(log.args, "key");
  const operator = arg.addr(log.args, "operator");
  const validUntil = arg.num(log.args, "validUntil");
  await store.upsertAgentKey({
    bookId,
    key,
    operator,
    validUntil: validUntil > 0 ? new Date(validUntil * 1000) : null,
    inventoryTierUsd: usdDb(arg.big(log.args, "inventoryTierUsd")),
    registeredTx: log.txHash,
  });
  await emit(domainEvent("agent.registered", bookId, `agent.registered:${bookId}:${key}:${log.txHash}`, { bookId, key, operator }));
};

const keyRevoked: Handler = async ({ log, store, chain, emit }) => {
  const bookId = requireBook(log);
  const key = arg.addr(log.args, "key");
  const reason = symbolStr(arg.hex(log.args, "reason"));
  const operator = (await chain.mandateKeyOperator(log.address, key, log.blockNumber))?.toLowerCase() ?? "0x0000000000000000000000000000000000000000";
  await store.revokeAgentKey({ bookId, key, operator, revokedTx: log.txHash, reason });
  await emit(domainEvent("agent.revoked", bookId, `agent.revoked:${bookId}:${key}:${log.txHash}`, { bookId, key, reason }));
};

const mandateKill: Handler = async ({ log, ts, store, watch, emit }) => {
  const bookId = requireBook(log);
  const reason = symbolStr(arg.hex(log.args, "reason"));
  const by = arg.addr(log.args, "by");
  const actions = ["mandate_kill", "revoke_desk_keys"];
  await store.insertKillIfAbsent({ bookId, ts, reason, breaches: [], actions, txHash: log.txHash });
  // Book-initiated kill (drawdown at mark) has no risk-service run behind it: the indexer is the
  // natural producer of kill.executed. RISK-role kills are announced by the risk service.
  const book = watch.components(bookId)?.book?.toLowerCase();
  if (book && by === book) {
    await emit(domainEvent("kill.executed", bookId, `kill.executed:${bookId}:${log.txHash}`, { bookId, reason, actions, txHashes: [log.txHash] }));
  }
};

export const HANDLERS: Record<string, Handler> = {
  "charter.CharterFiled": charterFiled,
  "charter.CharterDecided": charterDecided,
  "charter.CharterExpired": charterExpired,
  "charter.CharterRetired": charterRetired,
  "charter.SponsorSlashed": sponsorSlashed,
  "committee.JuryVerdictPosted": juryVerdictPosted,
  "committee.Voted": voted,
  "committee.MemberSet": memberSet,
  "committee.MemberBonded": memberBonded,
  "committee.MemberSlashed": memberSlashed,
  "factory.BookCreated": bookCreated,
  "markRegistry.MarkCommitted": markCommitted,
  "markRegistry.MarkApplied": registryMarkApplied,
  "book.WindowClosed": windowClosed,
  "book.BookCancelled": bookCancelled,
  "book.MarkApplied": bookMarkApplied,
  "book.LossAbsorbed": lossAbsorbed,
  "book.Retiring": retiring,
  "book.Retired": retired,
  "book.Killed": killed,
  "book.SponsorBelowSkin": sponsorBelowSkin,
  "senior.Committed": committed,
  "junior.Committed": committed,
  "senior.AllocationClaimed": allocationClaimed,
  "junior.AllocationClaimed": allocationClaimed,
  "senior.RedeemRequest": redeemRequest,
  "junior.RedeemRequest": redeemRequest,
  "senior.BucketSettled": bucketSettled,
  "junior.BucketSettled": bucketSettled,
  "senior.RedemptionClaimed": redemptionClaimed,
  "junior.RedemptionClaimed": redemptionClaimed,
  "router.Distributed": distributed,
  "router.SettlementReceived": settlementReceived,
  "mandate.KeyRegistered": keyRegistered,
  "mandate.KeyRevoked": keyRevoked,
  "mandate.Kill": mandateKill,
};

export const handlerFor = (l: DecodedLog): Handler | undefined => HANDLERS[`${l.kind}.${l.eventName}`];

/** BookCreated pre-scan: components to watch before fetching book logs for the same range. */
export function booksCreatedIn(logs: readonly DecodedLog[]): Array<{ bookId: number; components: BookComponents }> {
  return logs
    .filter((l) => l.kind === "factory" && l.eventName === "BookCreated")
    .map((l) => ({ bookId: arg.num(l.args, "bookId"), components: componentsFromArgs(l.args) }));
}

