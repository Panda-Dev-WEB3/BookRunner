// The desk's hash views, rendered from live API / chain data (store.ts). Markup and classes follow
// the original dashboard so dashboard.css, the art and the animations apply unchanged.
import type { Address } from "viem";
import { BKRN_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "./amount";
import { CHAIN, OPERATOR_APP_URL } from "./config";
import { ago, bpsPct, date, dateTime, duration, esc, num, pct, price, short, signedUsd, time, toNum, usd } from "./format";
import { addrLink, badge, btn, empty, errorBox, loading, metric, navChart, notice, panel, splitList, table, txLink } from "./html";
import {
  agentRows,
  bookArt,
  bookCard,
  bookTicker,
  chartGeometry,
  charterRow,
  depositWindow,
  isSponsor,
  markRow,
  overview as overviewModel,
  portfolioTotal,
  positionRowVisible,
  positionView,
  riskView,
  settlementRow,
  settlementTotals,
  statusClass,
  termsView,
} from "./model";
import { type Store, selected } from "./store";
import type { BookListItem, EventItem } from "./types";

export interface ViewCtx {
  s: Store;
  me: Address | null;
  rightChain: boolean;
  now: number;
}

const usdc = (v: bigint | null | undefined) => (v == null ? "-" : `$${formatAmountDisplay(v, USDC_DECIMALS)}`);
const shares = (v: bigint | null | undefined) => (v == null ? "-" : formatAmountDisplay(v, USDC_DECIMALS, 4));
const bkrnAmt = (v: bigint | null | undefined) => (v == null ? "-" : formatAmountDisplay(v, BKRN_DECIMALS, 2));
const ethAmt = (v: bigint | null | undefined) => (v == null ? "-" : `${formatAmountDisplay(v, 18, 4)} ETH`);
const err = (s: Store, key: string) => (s.errors[key] ? errorBox(s.errors[key] as string) : "");

const TESTNET_NOTE = `Live on ${CHAIN.name}. Testnet tokens have no value.`;

function connectPrompt(text: string): string {
  return `<div class="empty">${text}<br><br>${btn("Connect wallet", "connect", {}, "btn")}</div>`;
}

function wrongChainBanner(ctx: ViewCtx): string {
  if (!ctx.me || ctx.rightChain) return "";
  return notice(`Your wallet is on another network. Transactions on this desk go to ${esc(CHAIN.name)} (chain ${CHAIN.id}). ${btn("Switch network", "switchChain", {}, "btn-small")}`, "warn");
}

// ------------------------------------------------------------------ overview
function activityTitle(e: EventItem): string {
  const known: Record<string, string> = {
    "mark.committed": "Mark committed",
    "distribution.paid": "Distribution paid",
    "charter.filed": "Charter filed",
    "charter.decided": "Charter decided",
    "risk.kill": "Risk kill",
    "deposit.committed": "Deposit committed",
    "redemption.requested": "Redemption requested",
  };
  return known[e.type] ?? e.type.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function activityDetail(e: EventItem, books: BookListItem[]): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const b = books.find((x) => x.bookId === e.bookId);
  const who = b ? bookTicker(b.symbol) : e.bookId ? `Book #${e.bookId}` : "Protocol";
  const parts: string[] = [who];
  if (e.type === "mark.committed") parts.push(`NAV ${usd(d.navUsd as string)}`);
  if (e.type === "distribution.paid") parts.push(`gross ${usd(d.grossUsd as string)}, carry ${usd(d.carryUsd as string)}, Senior ${usd(d.seniorUsd as string)}, Junior ${usd(d.juniorUsd as string)}`);
  return esc(parts.join(" · ")) + (typeof d.txHash === "string" ? ` ${txLink(d.txHash, "tx")}` : "");
}

function activity(events: EventItem[] | null, books: BookListItem[]): string {
  if (events === null) return loading("Reading recent activity");
  if (!events.length) return empty("Recorded book activity appears here.");
  return events
    .slice(0, 7)
    .map((e) => `<div class="activity"><span class="activity-dot"></span><div><strong>${esc(activityTitle(e))}</strong><p>${activityDetail(e, books)}</p></div><time>${esc(date(e.createdAt))}<br>${esc(time(e.createdAt))}</time></div>`)
    .join("");
}

function bookRows(books: BookListItem[]): string[][] {
  return books.map((b) => {
    const c = bookCard(b);
    return [
      `<a class="table-name" href="#book/${b.bookId}">${esc(c.ticker)}</a><small>${esc(c.venue)} · ${esc(b.symbol)}</small>`,
      badge(c.state, statusClass(c.state)),
      usd(c.markedNav),
      usd(c.seniorNav),
      usd(c.juniorNav),
      pct(c.inventoryUtil),
      `<a class="btn-small" href="#book/${b.bookId}">View book →</a>`,
    ];
  });
}

export function overview(ctx: ViewCtx): string {
  const { s } = ctx;
  const books = s.books ?? [];
  const o = overviewModel(books, ctx.now);
  const b = selected();
  const positions = Object.values(s.positions).map(positionView);
  const total = ctx.me && s.positionsOwner === ctx.me ? portfolioTotal(positions) : null;
  const yourCapital = ctx.me ? (s.positionsOwner === ctx.me ? usdc(total) : "…") : "Not connected";
  const navG = b ? chartGeometry(s.nav[b.bookId]?.points ?? []) : null;
  return `<img class="banner" src="/assets/optimized/bookrunner-banner.webp" alt="BookRunner engraved banner">${err(s, "books")}<div class="metrics">${metric("Live books", s.books ? String(o.liveBooks) : "…", `${o.books} book${o.books === 1 ? "" : "s"} on ${esc(CHAIN.name)}`)}${metric("Total marked NAV", s.books ? usd(o.totalMarkedNav) : "…", "Sum of each book's NAV at its last mark")}${metric("Latest mark", o.latestMarkAgeSec === null ? "-" : esc(duration(o.latestMarkAgeSec)), o.latestMarkAt ? `${esc(o.cadence ?? "")} marks · period ending ${esc(dateTime(o.latestMarkAt))}` : "No mark committed yet")}${metric("Your capital", yourCapital, ctx.me ? "Tranche value at the last share price" : "Connect a wallet to see your positions")}</div>${panel("The market books", s.books ? table(["Book", "State", "Marked NAV", "Senior NAV", "Junior NAV", "Inventory", ""], bookRows(books), "No book is open yet.") : loading("Reading the books"), '<a class="btn-small" href="#books">Explore all books →</a>')}<div class="two-col">${panel(`${esc(b ? bookTicker(b.symbol) : "Book")} · NAV history`, err(s, `nav:${b?.bookId}`) + (b && s.nav[b.bookId] ? navChart(navG) : loading("Reading NAV history")), '<a class="btn-small" href="#marks">Signed marks →</a>')}${panel("Desk activity", err(s, "events") + activity(s.events, books))}</div>${notice(`${TESTNET_NOTE} Book NAV, tranche prices and activity are read from the BookRunner API and the chain; nothing on this page is simulated. Senior and Junior both carry capital risk.`)}`;
}

// ------------------------------------------------------------------ books
export function books(ctx: ViewCtx): string {
  const { s } = ctx;
  if (!s.books) return err(s, "books") + loading("Reading the books");
  if (!s.books.length) return empty("No book is open yet. Books appear here once a charter is approved.");
  const nowSec = Math.floor(ctx.now / 1000);
  const cards = s.books
    .map((b) => {
      const c = bookCard(b);
      const art = bookArt(c.ticker);
      const w = depositWindow(b.state, b.subscriptionEnds, s.topUps[b.bookId] ?? null, nowSec, b.markSchedule?.intervalSeconds ?? null);
      const deposits = w.kind === "subscription" ? (w.open ? `Open to ${esc(time(w.endsAt))}` : "Window closed") : w.kind === "topup" ? `Top-up to ${esc(date(w.endsAtSec))}` : "Closed";
      return `<article class="book-card"><div class="book-art"><img src="${art.src}" loading="lazy" decoding="async" alt="${esc(art.alt)}"><span>${esc(c.ticker)}</span></div><div class="book-card-body">${badge(c.state, statusClass(c.state))}<dl class="split-list"><dt>Book NAV</dt><dd>${usd(c.markedNav)}</dd><dt>Venue</dt><dd>${esc(c.venue)}</dd><dt>Senior price</dt><dd>${price(c.seniorPrice)}</dd><dt>Junior price</dt><dd>${price(c.juniorPrice)}</dd><dt>Deposits</dt><dd>${deposits}</dd></dl><div class="btn-row"><a class="btn" href="#book/${b.bookId}">View book →</a>${btn("Subscribe", "form", { kind: "subscribe", bookId: b.bookId }, "btn-outline")}</div></div></article>`;
    })
    .join("");
  return `${err(s, "books")}<div class="book-cards">${cards}</div>${notice(`${TESTNET_NOTE} Each book's NAV and share prices come from its last committed mark. A Live book takes deposits only during a sponsor top-up round; deposits stay in escrow until the first mark after the round end.`)}`;
}

// ------------------------------------------------------------------ book detail
export function bookTitle(ctx: ViewCtx): string {
  const b = selected();
  if (!b) return "Market book";
  const d = ctx.s.details[b.bookId];
  const state = d?.state ?? b.state;
  return `${esc(bookTicker(b.symbol, d?.charter?.ticker))} · ${badge(state, statusClass(state))}`;
}

export function bookDetail(ctx: ViewCtx): string {
  const { s } = ctx;
  const b = selected();
  if (!b) return err(s, "books") + loading("Reading the book");
  const d = s.details[b.bookId];
  const card = bookCard(b);
  const own = ctx.me && s.positionsOwner === ctx.me ? s.positions[b.bookId] : undefined;
  const pos = own ? positionView(own) : null;
  const terms = d ? termsView(d) : null;
  const nowSec = Math.floor(ctx.now / 1000);
  const w = depositWindow(d?.state ?? b.state, d?.subscriptionEnds ?? b.subscriptionEnds, s.topUps[b.bookId] ?? null, nowSec, b.markSchedule?.intervalSeconds ?? null);
  const risk = riskView(d?.limits ?? b.limits, d?.mandate ?? null, d?.killed ?? false);
  const next = b.markSchedule?.nextPeriodEndAt;
  const trancheP = (t: "senior" | "junior") => {
    const row = pos?.rows.find((r) => r.tranche === t);
    const navV = t === "senior" ? (d?.seniorNavUsd ?? b.seniorNavUsd) : (d?.juniorNavUsd ?? b.juniorNavUsd);
    const px = t === "senior" ? (d?.seniorSharePrice ?? b.seniorSharePrice) : (d?.juniorSharePrice ?? b.juniorSharePrice);
    const mine = !ctx.me ? "Connect a wallet" : row ? `${shares(row.shares)}${row.claimableShares && row.claimableShares > 0n ? `<small>+ ${shares(row.claimableShares)} to claim</small>` : ""}` : "…";
    const fee = t === "senior" ? (terms?.seniorHurdleBps != null ? `${bpsPct(terms.seniorHurdleBps)} hurdle share` : "Hurdle share") : "Residual";
    const redemption = t === "senior" ? "First mark on or after the request" : terms?.juniorNoticeSeconds != null ? `${esc(duration(terms.juniorNoticeSeconds))} notice, then the next mark` : "Notice, then the next mark";
    return panel(
      `${t === "senior" ? "Senior" : "Junior"} tranche`,
      `${badge(t === "senior" ? "Last loss" : "First loss")}${splitList([
        ["Tranche NAV", usd(navV)],
        ["NAV per share", price(px)],
        ["Your shares", mine],
        ["Fee flow", fee],
        ["Redemption", redemption],
      ])}<div class="btn-row">${btn("Subscribe", "form", { kind: "subscribe", bookId: b.bookId, tranche: t }, "btn")}${btn("Request redemption", "form", { kind: "redeem", bookId: b.bookId, tranche: t })}</div>`,
    );
  };
  const depositsText =
    w.kind === "subscription"
      ? w.open
        ? `Subscription window open until ${esc(dateTime(w.endsAt))}`
        : "Subscription window closed; allocation settles when the window is closed on-chain"
      : w.kind === "topup"
        ? `Top-up round open until ${esc(dateTime(w.endsAtSec))}${w.settlesAtSec ? `, settles at the ${esc(dateTime(w.settlesAtSec))} mark` : ""}. Capacity: Senior ${usdc(w.seniorCapacityUsd)}, Junior ${usdc(w.juniorCapacityUsd)}`
        : esc(w.reason);
  const sponsor = isSponsor(d, ctx.me);
  const termsBody = terms
    ? `${splitList([
        ["Underlying", esc(terms.underlying)],
        ["Venue", esc(terms.venue)],
        ["Oracle", esc(terms.oracle)],
        ["Trading sessions", esc(terms.sessions)],
        ["Insurance-fund size", usd(terms.ifTargetUsd)],
        ["Market-making inventory", usd(terms.mmInventoryUsd)],
        ["Senior capital cap", bpsPct(terms.seniorCapBps)],
        ["Per-wallet cap per round", terms.perWalletCapUsd ? usd(terms.perWalletCapUsd) : "None"],
        ["Deposits", depositsText],
        ["Sponsor", addrLink(terms.sponsor)],
        ["Charter status", esc(d?.charterStatus ?? "-")],
      ])}`
    : d
      ? empty("Charter terms are not indexed for this book.")
      : err(s, `detail:${b.bookId}`) + loading("Reading the charter");
  return `${wrongChainBanner(ctx)}<div class="metrics">${metric("Book NAV", usd(card.markedNav), card.lastMarkAt ? `At the mark ending ${esc(dateTime(card.lastMarkAt))}` : "No mark yet")}${metric("Live NAV", usd(card.liveNav), "Unmarked estimate from the risk service")}${metric("Risk state", esc(risk.operating), "Redemption requests stay open")}${metric("Next mark", next ? esc(ago(next, ctx.now)) : "-", next ? `Period ending ${esc(time(next))} · ${esc(b.markSchedule?.cadence ?? "")}` : "Not scheduled")}</div><div class="two-col">${trancheP("senior")}${trancheP("junior")}</div>${panel("Committed NAV", err(s, `nav:${b.bookId}`) + (s.nav[b.bookId] ? navChart(chartGeometry(s.nav[b.bookId]?.points ?? [])) : loading("Reading NAV history")))}${panel(
    "Charter & operating terms",
    `${termsBody}<div class="btn-row">${btn("Open top-up round", "form", { kind: "topup", bookId: b.bookId }, sponsor ? "btn" : "btn-outline")}<a class="btn-small" href="#risk">Inspect mandate →</a><a class="btn-small" href="#charters">Charter review →</a><a class="btn-small" href="#settings">Contracts →</a></div>`,
  )}${notice(`Charter values are this book's on-chain terms. Opening a top-up round is a sponsor transaction; on-chain permissions decide. Deposits stay in escrow until the first mark after the round end and cannot be cancelled before. Senior and Junior both carry capital risk. ${TESTNET_NOTE}`)}`;
}

// ------------------------------------------------------------------ portfolio
export function portfolio(ctx: ViewCtx): string {
  const { s } = ctx;
  if (!ctx.me) return `${panel("Your capital", connectPrompt("Connect a wallet to see its USDC, ETH and $BKRN balances, tranche positions, pending deposits and redemption requests."))}${notice(`Positions are read per wallet from the tranches on ${esc(CHAIN.name)}. ${TESTNET_NOTE}`)}`;
  const mine = s.positionsOwner === ctx.me;
  const views = mine ? Object.values(s.positions).map(positionView) : [];
  const booksById = new Map((s.books ?? []).map((b) => [b.bookId, b]));
  const tick = (id: number) => {
    const b = booksById.get(id);
    return b ? bookTicker(b.symbol) : `#${id}`;
  };
  const rows = views.flatMap((v) =>
    v.rows.filter(positionRowVisible).map((r) => {
      const claimable = [
        r.claimableShares && r.claimableShares > 0n ? `${shares(r.claimableShares)} shares` : "",
        r.claimableRefundUsd && r.claimableRefundUsd > 0n ? `${usdc(r.claimableRefundUsd)} refund` : "",
        r.claimableRedemptionUsd && r.claimableRedemptionUsd > 0n ? `${usdc(r.claimableRedemptionUsd)} redeemed` : "",
      ].filter(Boolean);
      const actions = [
        r.shares && r.shares > 0n ? btn("Redeem", "form", { kind: "redeem", bookId: r.bookId, tranche: r.tranche }, "btn-small") : "",
        claimable.length ? btn("Claim", "claim", { bookId: r.bookId }, "btn-small") : "",
      ].join(" ");
      return [
        `<a href="#book/${r.bookId}" class="table-name">${esc(tick(r.bookId))}</a>`,
        badge(r.tranche === "senior" ? "Senior" : "Junior"),
        shares(r.shares),
        usdc(r.valueUsd),
        r.committedUsd && r.committedUsd > 0n ? `${usdc(r.committedUsd)}<small>In escrow until the round settles</small>` : "-",
        claimable.length ? claimable.join("<br>") : "-",
        actions || "-",
      ];
    }),
  );
  const reqs = views.flatMap((v) =>
    v.redemptions.map((r) => [
      `<span class="hash">#${esc(r.requestId)}</span>${r.requestTx ? `<br>${txLink(r.requestTx, "tx")}` : ""}`,
      `${esc(tick(r.bookId))} · ${r.tranche}`,
      num(r.shares),
      esc(dateTime(r.eligibleAt)),
      `${esc(dateTime(r.settlesAtPeriodEnd))}<small>First mark on or after the eligible time</small>`,
      badge(r.status, statusClass(r.status === "claimable" ? "live" : r.status)),
      r.assetsUsd ? usd(r.assetsUsd) : r.status === "claimable" ? btn("Claim", "claim", { bookId: r.bookId }, "btn-small") : "-",
    ]),
  );
  const bal = s.balancesOwner === ctx.me ? s.balances : null;
  const total = mine ? portfolioTotal(views) : null;
  const pending = views.reduce((a, v) => a + v.pendingDepositUsd, 0n);
  const mintBtn = s.mintable ? btn("Mint 10,000 test USDC", "mint", {}, "btn") : "";
  return `${wrongChainBanner(ctx)}${err(s, "positions")}${err(s, "balances")}<div class="metrics">${metric("Wallet USDC", bal ? usdc(bal.usdc) : "…", "Testnet USDC (mock token)")}${metric("Gas balance", bal ? ethAmt(bal.eth) : "…", `${CHAIN.nativeSymbol} on ${esc(CHAIN.name)}`)}${metric("Position value", mine ? usdc(total) : "…", "Shares at the last share price")}${metric("Pending deposits", mine ? usdc(pending) : "…", "In escrow until the round settles")}</div>${panel(
    "Your wallet",
    `${splitList([
      ["Account", addrLink(ctx.me, ctx.me)],
      ["$BKRN", bal ? `${bkrnAmt(bal.bkrn)} BKRN` : "…"],
      ["Network", ctx.rightChain ? esc(CHAIN.name) : "Another network"],
    ])}<div class="btn-row">${mintBtn}<a class="btn-outline" href="#books">Subscribe to a book →</a><a class="btn-outline" href="#staking">Stake $BKRN →</a></div>${s.mintable === false ? `<p>The USDC this deployment uses is not mintable from a wallet.</p>` : ""}`,
  )}${panel("Your tranche positions", mine ? table(["Book", "Tranche", "Shares", "Value at NAV", "Pending deposit", "Claimable", ""], rows, "No position yet. Subscribe to a book during its window or a top-up round.") : loading("Reading your positions"))}${panel(
    "Redemption requests",
    mine ? table(["Request", "Book / tranche", "Shares", "Eligible after", "Settles at", "Status", ""], reqs, "No redemption request yet.") : loading("Reading your requests"),
  )}${notice("A redemption request is always accepted and settles at the first mark on or after its eligible time, at that mark's share price; Junior first completes its notice period. Requests cannot be cancelled. Deposits stay in escrow until the first mark after the round end and cannot be cancelled before. A deposit pause never blocks redemptions or claims. " + TESTNET_NOTE)}`;
}

// ------------------------------------------------------------------ charters
export function charters(ctx: ViewCtx): string {
  const { s } = ctx;
  const bookByAddr = new Map((s.books ?? []).map((b) => [b.components.book.toLowerCase(), b.bookId]));
  const rows = (s.charters ?? []).map((c) => {
    const v = charterRow(c, s.charterDetails[c.charterId] ?? null);
    const votes = v.committee.length
      ? v.committee.map((m) => `${esc(short(m.member))}: ${m.voted ? "voted" : v.status !== "Filed" ? "did not vote" : m.bonded ? "awaiting vote" : "not bonded"}`).join("<br>")
      : "Committee not indexed";
    const committee = v.approvals === null ? "-" : `${v.approvals} / ${v.approveThreshold ?? 2} approve · ${v.rejections} reject<small>${votes}</small>`;
    const jury = v.juryCid ? `<span class="hash">${esc(v.juryCid)}</span><small>${v.juryRecommendApprove === null ? "" : v.juryRecommendApprove ? "Jury recommends approval" : "Jury recommends rejection"}</small>` : '<span class="hash">Awaiting jury</span>';
    const bookId = v.bookAddr ? bookByAddr.get(v.bookAddr.toLowerCase()) : undefined;
    const action = v.status === "Filed" ? btn("Review", "form", { kind: "charterVote", charterId: v.charterId }, "btn-small") : bookId ? `<a class="btn-small" href="#book/${bookId}">Open book</a>` : "-";
    return [`<span class="table-name">${esc(v.symbol)}</span><small>Filed ${esc(date(v.filedAt))} · charter #${v.charterId}</small>`, esc(v.venue), badge(v.status, statusClass(v.status)), committee, jury, action];
  });
  return `${err(s, "charters")}${panel("Charter review queue", s.charters ? table(["Charter", "Venue", "State", "Committee", "Jury reference", ""], rows, "No charter filed yet.") : loading("Reading charters"), btn("File a charter +", "form", { kind: "charterFile" }, "btn"))}${panel(
    "From charter to market book",
    '<div class="steps"><span>Sponsor bond & charter fee</span><span>Jury verdict</span><span>2-of-3 committee</span><span>Subscription window</span></div><p>Charters specify the underlying, venue, oracle, sessions, capital sizes, mandate, Senior hurdle and cap, Junior notice and the per-wallet cap.</p>' +
      notice("The flat charter fee and sponsor bond are set on-chain; the filing form validates the draft and shows the exact amounts and transactions before you sign. A rejected charter refunds the fee. Votes are RiskCommittee transactions from a bonded member wallet."),
  )}`;
}

// ------------------------------------------------------------------ agents
export function agents(ctx: ViewCtx): string {
  const { s } = ctx;
  const b = selected();
  if (!b) return loading("Reading the books");
  const a = s.agents[b.bookId];
  const ticker = bookTicker(b.symbol);
  const rows = a
    ? agentRows(a).map((k) => [
        `<span class="hash">${esc(k.key)}</span><small>${k.registeredTx ? txLink(k.registeredTx, "registration") : ""}</small>`,
        k.operator ? addrLink(k.operator) : "-",
        k.tierUsd === null ? "-" : `${usd(k.tierUsd)}<small>Valid until ${esc(date(k.validUntil))}</small>`,
        badge(k.status.charAt(0).toUpperCase() + k.status.slice(1), statusClass(k.status === "active" ? "live" : k.status)),
        k.status === "active" ? btn("Revoke", "form", { kind: "agentRevoke", bookId: b.bookId, key: k.key }, "btn-small danger") : esc(k.revokedReason ?? "-"),
      ])
    : [];
  const hb = a?.agent;
  return `${wrongChainBanner(ctx)}${err(s, `agents:${b.bookId}`)}${panel(`${esc(ticker)} · Agent desk`, a ? table(["Desk key", "Operator", "Inventory tier", "Status", ""], rows, "No desk key registered.") : loading("Reading desk keys"), btn("Register agent +", "form", { kind: "agentRegister", bookId: b.bookId }, "btn"))}${panel(
    "Key boundaries",
    `<p>Bookrunner agents quote and hedge under the book's mandate. Venue keys are trade-only. Desk keys registered on MMMandate validate hedge and inventory actions on-chain.</p>${splitList([
      ["Agent heartbeat", hb ? (hb.alive ? `Alive · ${esc(ago(hb.heartbeatAt, ctx.now))}` : hb.heartbeatAt ? `Silent since ${esc(dateTime(hb.heartbeatAt))}` : "No heartbeat") : "…"],
      ["Mandate", a ? (a.killed ? `Killed${a.killReason ? ` (${esc(a.killReason)})` : ""}` : "Active") : "…"],
      ["Capital withdrawal destination", "UnderwritingVault only"],
      ["Off-hours / held oracle", "Reduce-only"],
      ["Kill action", "Cancel · flatten · revoke"],
      ["Inventory tier", "$BKRN operator bond required"],
    ])}<div class="btn-row"><a class="btn-outline" href="#risk">Read the mandate →</a><a class="btn-outline" href="#staking">Access & bonding →</a></div>`,
  )}${notice("Registering a key is a sponsor transaction (MMMandate.registerKey); a third-party operator first signs consentKey from its own wallet. Revocation can come from the sponsor, the risk service, the committee or the key itself. Only public key addresses are entered here: never paste a private key or a venue secret.")}`;
}

// ------------------------------------------------------------------ risk
export function risk(ctx: ViewCtx): string {
  const { s } = ctx;
  const b = selected();
  if (!b) return loading("Reading the books");
  const l = s.limits[b.bookId];
  const d = s.details[b.bookId];
  const rs = s.risk[b.bookId];
  const mandate = l?.mandate ?? d?.mandate ?? null;
  const r = riskView(l?.latest ?? b.limits, mandate, d?.killed ?? rs?.state === "killed");
  const meter = (label: string, util: number | null, text: string, alert: boolean) =>
    `<div class="risk-meter"><div class="risk-meter-label"><span>${label}</span><span>${esc(text)}</span></div><div class="bar ${alert ? "alert" : ""}"><span style="width:${util === null ? 0 : Math.min(100, Math.abs(util) * 100).toFixed(1)}%"></span></div></div>`;
  const hedgeUtil = r.hedge.ratioBps !== null && r.hedge.maxBps ? r.hedge.ratioBps / r.hedge.maxBps : null;
  const meta = ((rs?.live as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
  const oracle = (meta.oracle ?? null) as { held?: boolean; stale?: boolean; priceId?: string; price?: number } | null;
  const kills = rs?.kills ?? [];
  return `${err(s, `limits:${b.bookId}`)}${err(s, `risk:${b.bookId}`)}<div class="metrics">${metric("Inventory utilisation", pct(r.inventory.util), mandate ? `Of ${usd(mandate.maxInventoryUsd)} maximum inventory` : "Mandate-bound inventory")}${metric("Skew utilisation", pct(r.skew.util), mandate ? `Absolute skew limit ${mandate.maxSkewBps} bps` : "Of the skew limit")}${metric("Drawdown", r.drawdown.bps === null ? "-" : `${r.drawdown.bps} bps`, r.drawdown.killAtBps !== null ? `Kill at ${r.drawdown.killAtBps} bps` : "Kill threshold")}${metric("Operating state", esc(r.operating), r.asOf ? `Reported ${esc(ago(r.asOf, ctx.now))}` : "Current charter")}</div><div class="two-col">${panel(
    "Mandate utilisation",
    meter("Inventory", r.inventory.util, r.inventory.text, r.inventory.alert) +
      meter("Skew", r.skew.util, r.skew.text, r.skew.alert) +
      meter("Hedge ratio", hedgeUtil, r.hedge.ratioBps === null ? "No hedge reading" : `${bpsPct(r.hedge.ratioBps)} · band ${bpsPct(r.hedge.minBps)} to ${bpsPct(r.hedge.maxBps)}`, r.hedge.inBand === false) +
      (mandate
        ? splitList([
            ["Hedge ratio band", `${bpsPct(mandate.hedgeRatioMinBps)} to ${bpsPct(mandate.hedgeRatioMaxBps)}`],
            ["Minimum quote width", `${mandate.minQuoteWidthBps} bps`],
            ["Maximum hedge leverage", `${num(mandate.maxHedgeLeverage, 2)}×`],
            ["No new risk off-hours", mandate.noNewRiskOffHours ? "Yes" : "No"],
            ["Drawdown kill", `${mandate.killAtDrawdownBps} bps`],
          ])
        : loading("Reading the mandate")),
  )}${panel(
    "Risk state & kills",
    `${splitList([
      ["Net exposure", r.netExposureUsd === null ? "-" : usd(r.netExposureUsd)],
      ["Trading session", r.offHours === null ? "-" : r.offHours ? "Off-hours (reduce-only)" : "Open"],
      ["Oracle feed", oracle ? `${esc(oracle.priceId ?? "")} ${oracle.price ? usd(oracle.price) : ""} · ${oracle.held ? "Held" : oracle.stale ? "Stale" : "Current"}` : "-"],
      ["Breaches", r.breaches.length ? esc(r.breaches.join(", ")) : "None"],
      ["Report", rs ? (rs.liveStale ? "Live report is stale" : "Live") : "…"],
    ])}${kills.length ? table(["When", "Reason", "Transactions"], kills.map((k) => [esc(dateTime(k.ts)), esc(k.reason), (Array.isArray(k.txHashes) ? (k.txHashes as unknown[]) : []).filter((h): h is string => typeof h === "string").map((h) => txLink(h, "tx")).join(" ") || "-"])) : '<p>No risk kill recorded for this book.</p>'}${notice("Loss order: Junior, then Senior, then venue ADL. A risk kill cancels quotes, flattens inventory within the mandate and revokes desk keys. Redemption requests remain accepted.")}`,
  )}</div>`;
}

// ------------------------------------------------------------------ marks
export function marks(ctx: ViewCtx): string {
  const { s } = ctx;
  const b = selected();
  if (!b) return loading("Reading the books");
  const items = s.marks[b.bookId];
  const rows = (items ?? []).map((m) => {
    const r = markRow(m);
    return [
      `${esc(date(r.periodEndAt))}<small>${esc(time(r.periodEndAt))} · mark #${r.markId}</small>`,
      usd(r.nav),
      `${usd(r.seniorNav)} / ${usd(r.juniorNav)}`,
      `${price(r.seniorPrice)} / ${price(r.juniorPrice)}`,
      `${signedUsd(r.pnl)}${r.feeFlow !== null ? `<small>Fee flow ${usd(r.feeFlow)}</small>` : ""}`,
      `<span class="hash">${esc(r.receiptsRoot.slice(0, 18))}…</span>`,
      `<div class="btn-row">${btn("Verify", "verifyMark", { markId: r.markId }, "btn-small")}${btn("Export", "exportMark", { bookId: b.bookId, markId: r.markId }, "btn-small")}${txLink(r.txHash, "tx")}</div>`,
    ];
  });
  const sch = b.markSchedule;
  return `${err(s, `marks:${b.bookId}`)}${panel(`${esc(bookTicker(b.symbol))} · Signed marks`, items ? table(["Period end", "Book NAV", "Senior / Junior NAV", "Share prices", "P&L", "Receipts root", ""], rows, "No mark committed yet.") : loading("Reading marks"), sch?.nextPeriodEndAt ? `<span class="preview-pill">Next mark ${esc(ago(sch.nextPeriodEndAt, ctx.now))}</span>` : "")}${panel(
    "Receipt-rooted accountability",
    `<p>Hourly receipt roots cover quotes, fills, hedges and decisions. Each mark brings book and tranche NAV, inventory and P&L together with the receipt root, signed and committed on-chain (MarkRegistry). Redemptions settle at the eligible mark.</p>${splitList([
      ["Mark cadence", esc(sch?.cadence ?? "-")],
      ["Interval", sch?.intervalSeconds ? esc(duration(sch.intervalSeconds)) : "-"],
      ["Last period end", sch?.lastPeriodEnd ? esc(dateTime(sch.lastPeriodEnd)) : "-"],
    ])}${notice("Verify recomputes the mark's receipts root from the hourly roots the API indexed and compares it with the committed root. The tx link opens the commit transaction on the explorer.")}`,
  )}`;
}

// ------------------------------------------------------------------ settlements
export function settlements(ctx: ViewCtx): string {
  const { s } = ctx;
  const b = selected();
  if (!b) return loading("Reading the books");
  const items = s.settlements[b.bookId];
  const all = (items ?? []).map(settlementRow);
  // the table lists distributions; venue fee-share rows are the inflows those distributions pay out
  const rows = all.filter((r) => r.source === "Distribution");
  const inflows = all.length - rows.length;
  const totals = settlementTotals(rows);
  const sp = s.stakingProtocol;
  return `${err(s, `settlements:${b.bookId}`)}${panel(
    `${esc(bookTicker(b.symbol))} · Fee-flow distributions`,
    items
      ? table(
          ["Period", "Gross / expenses", "10% carry", "Senior", "Junior", "Tx"],
          rows.map((r) => [`${esc(date(r.period ?? r.at))}<small>Period ending ${esc(time(r.period ?? r.at))}</small>`, `${usd(r.gross)} / ${usd(r.expenses)}`, usd(r.carry), usd(r.senior), usd(r.junior), txLink(r.txHash, "tx")]),
          "No distribution recorded yet.",
        ) + (inflows ? `<p>${inflows} venue fee-share inflow${inflows === 1 ? "" : "s"} in the same window fund these distributions.</p>` : "")
      : loading("Reading distributions"),
  )}<div class="two-col">${panel(
    "The fee waterfall",
    `<div class="steps"><span>Market fee flow</span><span>Expenses</span><span>10% carry</span><span>Senior hurdle → Junior residual</span></div><p>Expenses include oracle, keeper gas, charter costs and applicable venue costs. The charter defines the Senior hurdle share. Junior receives the residual.</p>${splitList([
      [`Distributions shown (${totals.periods})`, "Sum"],
      ["Gross fee flow", usd(totals.gross)],
      ["Expenses", usd(totals.expenses)],
      ["Protocol carry", usd(totals.carry)],
      ["To Senior", usd(totals.senior)],
      ["To Junior", usd(totals.junior)],
    ])}`,
  )}${panel(
    "Protocol carry allocation",
    `${splitList([
      ["Buyback-to-stakers", "50%"],
      ["Syndicate backstop", "50%"],
      ["Carry received (all books)", sp ? usdc(sp.carryReceivedUsd) : "…"],
      ["Sent to the backstop", sp ? usdc(sp.toBackstopUsd) : "…"],
      ["Spent on buybacks", sp ? usdc(sp.buybackSpentUsd) : "…"],
      ["Waiting for the next buyback", sp ? usdc(sp.buybackPendingUsd) : "…"],
      ["Management fee on capital", "None"],
    ])}<p>Lifetime totals read from BkrnFeeRouter on ${esc(CHAIN.name)}.</p>`,
  )}</div>`;
}

// ------------------------------------------------------------------ staking
export function staking(ctx: ViewCtx): string {
  const { s } = ctx;
  const sp = s.stakingProtocol;
  const p = ctx.me && s.stakeOwner === ctx.me ? s.stakePosition : null;
  const bal = ctx.me && s.balancesOwner === ctx.me ? s.balances : null;
  const nowSec = Math.floor(ctx.now / 1000);
  let positionBody: string;
  if (!ctx.me) positionBody = connectPrompt("Connect a wallet to stake $BKRN, request an unstake or claim distributions.");
  else if (!p) positionBody = err(s, "stakePosition") + loading("Reading your stake");
  else {
    const ready = p.pending > 0n && nowSec >= p.availableAt;
    const cooling = p.pending > 0n && !ready;
    positionBody = `${splitList([
      ["Staked", `${bkrnAmt(p.staked)} BKRN`],
      ["Free to unstake", `${bkrnAmt(p.available)} BKRN`],
      ["Locked as bonds", `${bkrnAmt(p.locked)} BKRN`],
      ["Unstake request", p.pending > 0n ? `${bkrnAmt(p.pending)} BKRN · ${ready ? "ready to withdraw" : `available ${esc(dateTime(p.availableAt))}`}` : "None"],
      ["Claimable distributions", `${formatAmountDisplay(p.earned, BKRN_DECIMALS, 4)} BKRN`],
    ])}<div class="btn-row">${btn("Stake", "form", { kind: "stake" }, "btn")}${p.available > 0n ? btn("Request unstake", "form", { kind: "unstake" }) : ""}${cooling ? btn("Cancel request", "cancelUnstake", {}) : ""}${ready ? btn("Withdraw", "withdrawUnstaked", {}, "btn") : ""}${p.earned > 0n ? btn("Claim distributions", "claimReward", {}) : ""}</div>`;
  }
  return `${wrongChainBanner(ctx)}${err(s, "protocol")}${err(s, "stakingProtocol")}<div class="metrics">${metric("Wallet $BKRN", ctx.me ? (bal ? bkrnAmt(bal.bkrn) : "…") : "-", ctx.me ? "Available to stake" : "Connect a wallet")}${metric("Your stake", p ? bkrnAmt(p.staked) : "-", p ? `${bkrnAmt(p.locked)} locked as bonds` : "Sponsor · committee · operator")}${metric("Total staked", sp ? bkrnAmt(sp.totalStaked) : "…", sp?.cooldownSec != null ? `Unstake cooldown ${esc(duration(sp.cooldownSec))}` : "BkrnStaking")}${metric("Backstop balance", sp ? usdc(sp.backstopBalanceUsd) : "…", "Available capital only")}</div><div class="two-col">${panel(
    "$BKRN access & bonding",
    `<p>Stake backs sponsor bonds, bonded Risk Committee seats and bookrunner inventory tiers. Locked stake cannot be unstaked; an unstake request waits out the cooldown before it can be withdrawn.</p>${positionBody}<div class="btn-row"><a class="btn-outline" href="#charters">Sponsor a charter →</a></div>`,
  )}${panel(
    "Syndicate backstop & buybacks",
    `${splitList([
      ["Backstop balance", sp ? usdc(sp.backstopBalanceUsd) : "…"],
      ["Cover paid to books", sp ? usdc(sp.backstopCoveredUsd) : "…"],
      ["Carry spent on buybacks", sp ? usdc(sp.buybackSpentUsd) : "…"],
      ["$BKRN distributed to stakers", sp ? `${bkrnAmt(sp.distributedBkrn)} BKRN` : "…"],
    ])}<p>Half of protocol carry funds the backstop; the other half buys $BKRN that is distributed to stakers. The backstop may cover a Senior shortfall only after Junior is exhausted, up to its balance.</p><div class="btn-row"><a class="btn-outline" href="#risk">Inspect book risk →</a></div>${notice("Coverage is bounded by the backstop pool. Senior capital can be lost. " + TESTNET_NOTE)}`,
  )}</div>`;
}

// ------------------------------------------------------------------ network (settings)
export function settings(ctx: ViewCtx): string {
  const { s } = ctx;
  const h = s.health;
  const b = selected();
  const p = s.protocol;
  const protocolRows = p
    ? (
        [
          ["BookrunnerConfig", p.config],
          ["USDC", p.usdc],
          ["$BKRN", p.bkrn],
          ["BkrnStaking", p.staking],
          ["BkrnFeeRouter", p.feeRouter],
          ["Backstop", p.backstop],
          ["MarkRegistry", p.markRegistry],
          ["Oracle", p.oracle],
          ["MarketCharter", p.charter],
          ["RiskCommittee", p.committee],
          ["BookFactory", p.factory],
        ] as Array<[string, string]>
      ).map(([n, a]) => [esc(n), addrLink(a, a)])
    : [];
  const comp = b?.components;
  const bookRowsT = comp
    ? (
        [
          ["Book", comp.book],
          ["Senior tranche", comp.senior],
          ["Junior tranche", comp.junior],
          ["UnderwritingVault", comp.vault],
          ["MMMandate", comp.mandate],
          ["Revenue router", comp.router],
          ["Bookrunner desk", comp.desk],
          ["Venue adapter", comp.adapter],
        ] as Array<[string, string]>
      ).map(([n, a]) => [esc(n), addrLink(a, a)])
    : [];
  return `${panel(
    "Network & services",
    `${splitList([
      ["Network", esc(CHAIN.name)],
      ["Chain ID", String(CHAIN.id)],
      ["Public RPC", `<span class="hash">${esc(CHAIN.rpcUrl)}</span>`],
      ["Explorer", `<a href="${esc(CHAIN.explorerUrl)}" target="_blank" rel="noopener">${esc(CHAIN.explorerUrl.replace(/^https:\/\//, ""))} ↗</a>`],
      ["BookRunner API", h ? (h.ok ? `Up · chain ${h.chainId ?? "-"}${h.chainId !== null && h.chainId !== CHAIN.id ? " (different chain)" : ""}` : "Unreachable") : "…"],
      ["Indexer database", h?.db ? esc(h.db) : "-"],
      ["Live state cache", h?.redis ? esc(h.redis) : "-"],
      ["Your wallet", ctx.me ? `${addrLink(ctx.me, ctx.me)}${ctx.rightChain ? "" : " · another network"}` : "Not connected"],
    ])}<div class="btn-row"><a class="btn-outline" href="${OPERATOR_APP_URL}">Operator app →</a>${ctx.me && !ctx.rightChain ? btn("Switch network", "switchChain", {}, "btn") : ""}</div>${notice("Everything on this desk is read-only until you sign a transaction in your own wallet. Contract addresses come from the API's book list and the BookrunnerConfig each book points at.")}`,
  )}${panel("Protocol contracts", err(s, "protocol") + (p ? table(["Contract", "Address"], protocolRows) : loading("Reading BookrunnerConfig")))}${b ? panel(`${esc(bookTicker(b.symbol))} · Book contracts`, table(["Component", "Address"], bookRowsT)) : ""}${panel(
    "The source specification",
    '<p>BookRunner Spec v1.0 · 01 October 2026.</p><div class="btn-row"><a class="btn-outline" href="/documents/">Read specifications →</a><a class="btn-outline" href="/assets/documents/bookrunner-overview.pdf" target="_blank">Overview PDF ↗</a><a class="btn-outline" href="/assets/documents/bookrunner-backend.pdf" target="_blank">Backend PDF ↗</a></div>',
  )}`;
}
