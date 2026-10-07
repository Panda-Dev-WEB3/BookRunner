// The live book desk at /dashboard/: the original desk's layout, views and modals, fed by the
// BookRunner API (same-origin /trpc, /health) and the chain, with a real EIP-1193 wallet.
import type { Address } from "viem";
import { claim, exportMark, initActions, mint, openAction, openConnect, openWalletMenu, stakingAction, switchChain, verifyMark } from "./actions";
import { CHAIN, OPERATOR_APP_URL } from "./config";
import { esc, short } from "./format";
import { btn } from "./html";
import { bookTicker } from "./model";
import {
  ROLES,
  type Role,
  clearWalletData,
  loadAgents,
  loadBalances,
  loadBooks,
  loadCharters,
  loadDetail,
  loadEvents,
  loadHealth,
  loadLimits,
  loadMarks,
  loadMaxTopUpWindow,
  loadMintable,
  loadNav,
  loadPositions,
  loadProtocol,
  loadRisk,
  loadSettlements,
  loadStakePosition,
  loadStakingProtocol,
  loadTopUp,
  savePrefs,
  selected,
  setOnChange,
  store,
} from "./store";
import * as V from "./views";
import { WalletManager } from "./wallet";

const app = document.getElementById("app") as HTMLElement;
const modal = document.getElementById("action-modal") as HTMLDialogElement;
const toastEl = document.getElementById("toast") as HTMLElement;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const wallet = new WalletManager();

function notify(message: string, error = false): void {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `visible${error ? " error" : ""}`;
  toastTimer = setTimeout(() => (toastEl.className = ""), 6000);
}

const deskIconFiles: Record<string, string> = {
  overview: "/assets/greek-ui/overview-v12.svg",
  books: "/assets/greek-ui/books-v12.svg",
  portfolio: "/assets/greek-ui/portfolio-v12.svg",
  charters: "/assets/greek-ui/charters-v12.svg",
  agents: "/assets/greek-ui/agents-v12.svg",
  risk: "/assets/greek-ui/risk-v12.svg",
  marks: "/assets/greek-ui/marks-v12.svg",
  settlements: "/assets/greek-ui/settlements-v12.svg",
  staking: "/assets/greek-ui/staking-v12.svg",
  settings: "/assets/greek-ui/settings-v12.svg",
};
const deskIcon = (key: string) => `<img src="${deskIconFiles[key] ?? deskIconFiles.books}" alt="" aria-hidden="true" width="26" height="26" loading="eager" decoding="async">`;

type ViewKey = "overview" | "books" | "book" | "portfolio" | "charters" | "agents" | "risk" | "marks" | "settlements" | "staking" | "settings";
const pages: Record<ViewKey, [string, string, (c: V.ViewCtx) => string]> = {
  overview: ["The book desk", "Run the book. Follow its capital, mandate and every signed mark.", V.overview],
  books: ["The market books", "Per-market underwriting. Pick a book and choose your place in the waterfall.", V.books],
  book: ["", "Capital terms, tranche NAV and the current mandate.", V.bookDetail],
  portfolio: ["Your capital", "Wallet balances, tranche positions, pending deposits and redemption requests.", V.portfolio],
  charters: ["Market charters", "Sponsor a book. Review its terms. Vote it through committee.", V.charters],
  agents: ["Agent bookrunners", "Desk keys, operators and mandate boundaries.", V.agents],
  risk: ["The risk mandate", "Inventory, skew, hedge bounds and the book's operating state.", V.risk],
  marks: ["Signed marks", "Book-level NAV with receipt roots, committed on-chain.", V.marks],
  settlements: ["The fee waterfall", "Fee flow, expenses, protocol carry and tranche distributions.", V.settlements],
  staking: ["Access & bonding", "$BKRN stake, cooldowns, distributions and the syndicate backstop.", V.staking],
  settings: ["The network", "Chain, API and contract addresses this desk reads.", V.settings],
};

/** "#book/2" -> view "book" with book 2 selected; unknown hashes fall back to the overview. */
function currentView(): ViewKey {
  const [h = "", id] = location.hash.slice(1).split("/");
  if (h === "book" && id && /^\d+$/.test(id)) {
    const n = Number(id);
    if (store.selectedBook !== n && (store.books === null || store.books.some((b) => b.bookId === n))) {
      store.selectedBook = n;
      savePrefs(store);
    }
  }
  return (h in pages ? h : "overview") as ViewKey;
}

const ctx = (): V.ViewCtx => {
  const s = wallet.snapshot;
  return { s: store, me: s.address, rightChain: wallet.onRightChain, now: Date.now() };
};

function header(): string {
  const s = wallet.snapshot;
  const walletBtn = !s.address
    ? btn(s.connecting ? "Connecting…" : "Connect wallet", "connect", {}, "btn")
    : !wallet.onRightChain
      ? btn("Switch network", "switchChain", {}, "btn")
      : btn(esc(short(s.address)), "walletMenu", {}, "btn-outline wallet-chip", `aria-label="Wallet ${esc(s.address)}"`);
  const pill = s.address && !wallet.onRightChain ? `<span class="preview-pill warn">Wrong network</span>` : `<span class="preview-pill">${esc(CHAIN.name)}</span>`;
  return `<header class="desk-header"><a class="brand" href="/#hero"><span class="wordmark-name">BookRunner</span></a><div class="header-actions"><a href="/research/">Reports</a><a href="/jobs/">Bookrunners</a><a href="${OPERATOR_APP_URL}">Operator app</a>${pill}${walletBtn}</div></header>`;
}

function sidebar(view: ViewKey): string {
  const s = wallet.snapshot;
  const books = store.books ?? [];
  const sel = selected();
  return `<aside class="sidebar"><div><label for="role-switch">View as</label><select id="role-switch">${ROLES.map(([v, t]) => `<option value="${v}" ${store.role === v ? "selected" : ""}>${t}</option>`).join("")}</select></div><nav class="side-links" aria-label="Desk navigation">${(
    [
      ["overview", "Overview"],
      ["books", "Books"],
      ["portfolio", "Capital"],
      ["risk", "Risk"],
    ] as const
  )
    .map(([key, label]) => `<a href="#${key}" data-nav-key="${key}" class="${view === key || (view === "book" && key === "books") ? "active" : ""}"><span class="side-icon" aria-hidden="true">${deskIcon(key)}</span><span>${label}</span></a>`)
    .join("")}<button type="button" class="mobile-more-trigger ${["charters", "agents", "marks", "settlements", "staking", "settings"].includes(view) ? "active" : ""}" data-action="mobileMore" aria-expanded="false" aria-controls="mobile-more-menu"><span class="more-symbol" aria-hidden="true">•••</span><span>More</span></button><div class="secondary-links" id="mobile-more-menu">${(
    [
      ["charters", "Charters"],
      ["agents", "Bookrunners"],
      ["marks", "Signed marks"],
      ["settlements", "Fee waterfall"],
      ["staking", "Access & bonding"],
      ["settings", "Network"],
    ] as const
  )
    .map(([key, label]) => `<a href="#${key}" class="${view === key ? "active" : ""}"><span class="side-icon" aria-hidden="true">${deskIcon(key)}</span>${label}</a>`)
    .join("")}<a href="${OPERATOR_APP_URL}" class="operator-link"><span class="side-icon" aria-hidden="true">${deskIcon("settings")}</span>Operator app ↗</a></div></nav><div class="book-switcher"><label for="book-switch">Selected book</label><select id="book-switch">${books.map((b) => `<option value="${b.bookId}" ${b.bookId === sel?.bookId ? "selected" : ""}>${esc(bookTicker(b.symbol))}</option>`).join("") || "<option>Reading…</option>"}</select></div><div class="side-bottom">${esc(CHAIN.name)} · ${CHAIN.id}<br><a href="/documents/">Read the specifications ↗</a><br><a href="${OPERATOR_APP_URL}">Operator app ↗</a><br><span class="hash">${s.address ? esc(s.address) : "Wallet not connected"}</span></div></aside>`;
}

function titleAction(view: ViewKey): string {
  if (view === "books") return btn("File a charter +", "form", { kind: "charterFile" }, "btn");
  if (view === "portfolio") return btn("Subscribe +", "form", { kind: "subscribe" }, "btn");
  if (view === "overview") {
    const byRole: Record<Role, string> = {
      allocator: btn("Subscribe +", "form", { kind: "subscribe" }, "btn"),
      sponsor: btn("File a charter +", "form", { kind: "charterFile" }, "btn"),
      committee: '<a class="btn" href="#charters">Review charters →</a>',
      operator: '<a class="btn" href="#agents">Desk keys →</a>',
    };
    return byRole[store.role];
  }
  return "";
}

let renderQueued = false;
let last = { header: "", sidebar: "", main: "" };
function render(): void {
  // never rebuild the page under an open <select> or a field being typed in
  const active = document.activeElement;
  if (active && app.contains(active) && (active.tagName === "SELECT" || active.tagName === "INPUT")) {
    active.addEventListener("blur", () => scheduleRender(), { once: true });
    return;
  }
  const view = currentView();
  const page = pages[view];
  const c = ctx();
  let body: string;
  try {
    body = page[2](c);
  } catch (e) {
    console.error(e);
    body = `<div class="notice error">This view could not be drawn: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
  const title = view === "book" ? V.bookTitle(c) : page[0];
  const next = {
    header: header(),
    sidebar: sidebar(view),
    main: `<div class="desk-title"><div><p class="eyebrow">BOOKRUNNER / ${view === "book" ? "MARKET BOOK" : view === "settings" ? "NETWORK" : esc(view.toUpperCase())}</p><h1>${title}</h1><p class="subtitle">${page[1]}</p></div>${titleAction(view)}</div>${body}`,
  };
  // only the parts whose markup changed are rebuilt, so polling does not re-create unchanged art
  const headerEl = app.querySelector("header.desk-header");
  const asideEl = app.querySelector("aside.sidebar");
  const mainEl = app.querySelector("main.desk-main");
  if (!headerEl || !asideEl || !mainEl) {
    app.innerHTML = `${next.header}<div class="desk-grid">${next.sidebar}<main class="desk-main">${next.main}</main></div>`;
  } else {
    if (next.header !== last.header) headerEl.outerHTML = next.header;
    if (next.sidebar !== last.sidebar) asideEl.outerHTML = next.sidebar;
    if (next.main !== last.main) mainEl.innerHTML = next.main;
  }
  last = next;
  (document.getElementById("role-switch") as HTMLSelectElement).onchange = (e) => {
    store.role = (e.target as HTMLSelectElement).value as Role;
    savePrefs(store);
    scheduleRender();
  };
  (document.getElementById("book-switch") as HTMLSelectElement).onchange = (e) => {
    const id = Number((e.target as HTMLSelectElement).value);
    store.selectedBook = id;
    savePrefs(store);
    if (location.hash.startsWith("#book")) location.hash = `book/${id}`;
    else {
      scheduleRender();
      void refreshView();
    }
  };
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  // a timer, not requestAnimationFrame: rAF is paused in hidden tabs, which would hold every update
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 16);
}

// ------------------------------------------------------------------ data
let refreshing = false;
async function refreshView(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const view = currentView();
    await Promise.all([loadHealth(), loadBooks()]);
    await loadProtocol();
    const me = wallet.snapshot.address as Address | null;
    const b = selected();
    const jobs: Array<Promise<void>> = [];
    const wantPositions = ["overview", "book", "portfolio"].includes(view);
    if (me && wantPositions) jobs.push(loadPositions(me));
    if (me && ["portfolio", "staking", "book"].includes(view)) jobs.push(loadBalances(me));
    switch (view) {
      case "overview":
        jobs.push(loadEvents());
        if (b) jobs.push(loadNav(b.bookId));
        break;
      case "books":
        for (const x of store.books ?? []) jobs.push(loadTopUp(x));
        break;
      case "book":
        if (b) jobs.push(loadDetail(b.bookId), loadNav(b.bookId), loadTopUp(b), loadMaxTopUpWindow(b));
        break;
      case "portfolio":
        if (me) jobs.push(loadMintable(me));
        break;
      case "charters":
        jobs.push(loadCharters());
        break;
      case "agents":
        if (b) jobs.push(loadAgents(b.bookId), loadDetail(b.bookId));
        break;
      case "risk":
        if (b) jobs.push(loadLimits(b.bookId), loadRisk(b.bookId), loadDetail(b.bookId));
        break;
      case "marks":
        if (b) jobs.push(loadMarks(b.bookId));
        break;
      case "settlements":
        if (b) jobs.push(loadSettlements(b.bookId));
        jobs.push(loadStakingProtocol());
        break;
      case "staking":
        jobs.push(loadStakingProtocol());
        if (me) jobs.push(loadStakePosition(me));
        break;
      case "settings":
        break;
    }
    await Promise.all(jobs);
  } finally {
    refreshing = false;
  }
}

/** After a confirmed transaction: read now and again a few seconds later (RPC lag). */
function refreshAfterTx(): void {
  const me = wallet.snapshot.address as Address | null;
  const again = async () => {
    const b = selected();
    const jobs: Array<Promise<void>> = [refreshView()];
    if (me) jobs.push(loadPositions(me), loadBalances(me), loadStakePosition(me));
    if (b) jobs.push(loadTopUp(b), loadAgents(b.bookId));
    jobs.push(loadStakingProtocol(), loadCharters());
    await Promise.all(jobs);
  };
  void again();
  setTimeout(() => void again(), 5_000);
}

// ------------------------------------------------------------------ events
app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el) return;
  const action = el.dataset.action as string;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(el.dataset.args || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  switch (action) {
    case "mobileMore": {
      const open = document.body.classList.toggle("mobile-more-open");
      el.setAttribute("aria-expanded", String(open));
      return;
    }
    case "form":
      return openAction(String(args.kind), args);
    case "connect":
      return openConnect();
    case "walletMenu":
      return openWalletMenu();
    case "switchChain":
      return void switchChain();
    case "claim":
      return void claim(args);
    case "mint":
      return void mint();
    case "cancelUnstake":
    case "withdrawUnstaked":
    case "claimReward":
      return void stakingAction(action);
    case "verifyMark":
      return void verifyMark(Number(args.markId));
    case "exportMark":
      return exportMark(Number(args.bookId), Number(args.markId));
    default:
      notify("This action is not available on the live desk.", true);
  }
});

modal.addEventListener("click", (e) => {
  if (e.target !== modal) return;
  const r = modal.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close();
});

window.addEventListener("hashchange", () => {
  document.body.classList.remove("mobile-more-open");
  render();
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  void refreshView();
});

let lastAccount: string | null = null;
let lastChain: number | null = null;
wallet.subscribe((s) => {
  if (s.address !== lastAccount) {
    lastAccount = s.address;
    clearWalletData();
    void refreshView();
  } else if (s.chainId !== lastChain) void refreshView();
  lastChain = s.chainId;
  scheduleRender();
});

initActions({ wallet, modal, notify, refresh: refreshAfterTx, render: scheduleRender });
setOnChange(scheduleRender);
wallet.init();
render();
void refreshView();
setInterval(() => {
  if (document.visibilityState === "visible") void refreshView();
}, 15_000);
// ages ("in 4 min", "12 min ago") move without a refetch
setInterval(() => {
  if (document.visibilityState === "visible" && !modal.open) scheduleRender();
}, 30_000);
