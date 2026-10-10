// Live state of the desk: what the API and the chain answered, per view, refreshed by polling.
// Loaders record their own error and never throw; a re-render is requested only when data changed.
import type { Address } from "viem";
import { health, query } from "./api";
import {
  type Balances,
  type ProtocolContracts,
  type StakePosition,
  type StakingProtocol,
  canMintTestUsdc,
  readBalances,
  readMaxTopUpWindow,
  readProtocol,
  readStakePosition,
  readStakingProtocol,
  readTokenSymbol,
  readTopUp,
} from "./chain";
import type { TopUpRound } from "./model";
import { setSettlementSymbol } from "./token";
import type {
  AgentListOut,
  BookDetail,
  BookListItem,
  CharterDetail,
  CharterListItem,
  EventItem,
  Health,
  LimitsOut,
  MarkItem,
  NavSeries,
  PositionOut,
  RiskStateOut,
  SettlementItem,
} from "./types";

export type Role = "allocator" | "sponsor" | "committee" | "operator";
export const ROLES: Array<[Role, string]> = [
  ["allocator", "Capital allocator"],
  ["sponsor", "Market sponsor"],
  ["committee", "Risk Committee"],
  ["operator", "Bookrunner operator"],
];

export interface Store {
  health: Health | null;
  books: BookListItem[] | null;
  details: Record<number, BookDetail>;
  nav: Record<number, NavSeries>;
  marks: Record<number, MarkItem[]>;
  limits: Record<number, LimitsOut>;
  risk: Record<number, RiskStateOut>;
  settlements: Record<number, SettlementItem[]>;
  agents: Record<number, AgentListOut>;
  charters: CharterListItem[] | null;
  charterDetails: Record<number, CharterDetail>;
  events: EventItem[] | null;
  protocol: ProtocolContracts | null;
  /** symbol() of the settlement token (protocol.usdc), sanitized; null until read (labels show "USDC"). */
  settlementSymbol: string | null;
  topUps: Record<number, TopUpRound | null>;
  maxTopUpWindow: Record<number, number | null>;
  /** Positions of `positionsOwner` per book. */
  positions: Record<number, PositionOut>;
  positionsOwner: Address | null;
  balances: Balances | null;
  balancesOwner: Address | null;
  mintable: boolean | null;
  stakingProtocol: StakingProtocol | null;
  stakePosition: StakePosition | null;
  stakeOwner: Address | null;
  /** Loader key -> last error message (cleared on success). */
  errors: Record<string, string>;
  selectedBook: number | null;
  role: Role;
}

const PREFS_KEY = "bookrunner.site.prefs.v1";

function readPrefs(): { selectedBook: number | null; role: Role } {
  try {
    const p = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? "null") as { selectedBook?: unknown; role?: unknown } | null;
    const role = ROLES.some(([r]) => r === p?.role) ? (p?.role as Role) : "allocator";
    return { selectedBook: typeof p?.selectedBook === "number" ? p.selectedBook : null, role };
  } catch {
    return { selectedBook: null, role: "allocator" };
  }
}

export function savePrefs(s: Pick<Store, "selectedBook" | "role">): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ selectedBook: s.selectedBook, role: s.role }));
  } catch {
    /* not remembered */
  }
}

export const store: Store = {
  health: null,
  books: null,
  details: {},
  nav: {},
  marks: {},
  limits: {},
  risk: {},
  settlements: {},
  agents: {},
  charters: null,
  charterDetails: {},
  events: null,
  protocol: null,
  settlementSymbol: null,
  topUps: {},
  maxTopUpWindow: {},
  positions: {},
  positionsOwner: null,
  balances: null,
  balancesOwner: null,
  mintable: null,
  stakingProtocol: null,
  stakePosition: null,
  stakeOwner: null,
  errors: {},
  ...readPrefs(),
};

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const fingerprints = new Map<string, string>();
let onChange: () => void = () => {};
export const setOnChange = (fn: () => void) => {
  onChange = fn;
};

/** Runs a loader; records data / error under `key`; notifies only on change. */
async function load<T>(key: string, fn: () => Promise<T>, apply: (v: T) => void): Promise<void> {
  try {
    const v = await fn();
    const fp = stable(v);
    const hadError = key in store.errors;
    delete store.errors[key];
    if (fingerprints.get(key) === fp && !hadError) return;
    fingerprints.set(key, fp);
    apply(v);
    onChange();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (store.errors[key] === msg) return;
    store.errors[key] = msg;
    onChange();
  }
}

export const selected = (): BookListItem | null => {
  const list = store.books ?? [];
  return list.find((b) => b.bookId === store.selectedBook) ?? list[0] ?? null;
};

// ------------------------------------------------------------------ loaders
export const loadHealth = () => load("health", health, (v) => (store.health = v));

export const loadBooks = () =>
  load("books", () => query("book.list"), (v) => {
    store.books = v;
    if (store.selectedBook === null || !v.some((b) => b.bookId === store.selectedBook)) store.selectedBook = v[0]?.bookId ?? null;
  });

export const loadDetail = (id: number) => load(`detail:${id}`, () => query("book.get", { bookId: id }), (v) => (store.details[id] = v));
export const loadNav = (id: number) => load(`nav:${id}`, () => query("book.nav", { bookId: id, limit: 72 }), (v) => (store.nav[id] = v));
export const loadMarks = (id: number) => load(`marks:${id}`, () => query("book.marks", { bookId: id, limit: 24 }), (v) => (store.marks[id] = v.items));
export const loadLimits = (id: number) => load(`limits:${id}`, () => query("book.limits", { bookId: id }), (v) => (store.limits[id] = v));
export const loadRisk = (id: number) => load(`risk:${id}`, () => query("risk.state", { bookId: id }), (v) => (store.risk[id] = v));
export const loadSettlements = (id: number) => load(`settlements:${id}`, () => query("settlements.list", { bookId: id, limit: 48 }), (v) => (store.settlements[id] = v.items));
export const loadAgents = (id: number) => load(`agents:${id}`, () => query("agent.list", { bookId: id }), (v) => (store.agents[id] = v));
export const loadEvents = () => load("events", () => query("events.recent", { limit: 8 }), (v) => (store.events = v.items));

export const loadCharters = () =>
  load(
    "charters",
    async () => {
      const list = await query("charter.list", { limit: 50 });
      const details = await Promise.all(list.items.slice(0, 20).map((c) => query("charter.get", { charterId: c.charterId }).catch(() => null)));
      return { items: list.items, details };
    },
    (v) => {
      store.charters = v.items;
      for (const d of v.details) if (d) store.charterDetails[d.charterId] = d;
    },
  );

export const loadProtocol = () => {
  if (store.protocol) return Promise.resolve();
  const first = store.books?.[0]?.components.book;
  if (!first) return Promise.resolve();
  return load("protocol", () => readProtocol(first as Address), (v) => (store.protocol = v));
};

/** Reads the settlement token's symbol() once; every label then shows it (token.ts). */
export const loadSettlementSymbol = () => {
  const token = store.protocol?.usdc;
  if (!token || store.settlementSymbol !== null) return Promise.resolve();
  return load("settlementSymbol", () => readTokenSymbol(token), (v) => (store.settlementSymbol = setSettlementSymbol(v)));
};

export const loadTopUp = (b: BookListItem) => load(`topup:${b.bookId}`, () => readTopUp(b.components.book as Address), (v) => (store.topUps[b.bookId] = v));
export const loadMaxTopUpWindow = (b: BookListItem) => {
  if (b.bookId in store.maxTopUpWindow) return Promise.resolve();
  return load(`maxwindow:${b.bookId}`, () => readMaxTopUpWindow(b.components.book as Address), (v) => (store.maxTopUpWindow[b.bookId] = v));
};

export const loadPositions = (me: Address) =>
  load(
    "positions",
    async () => {
      const list = store.books ?? [];
      const rows = await Promise.all(list.map((b) => query("tranche.position", { bookId: b.bookId, wallet: me })));
      return { me, rows };
    },
    (v) => {
      store.positions = Object.fromEntries(v.rows.map((p) => [p.bookId, p]));
      store.positionsOwner = v.me;
    },
  );

export const loadBalances = (me: Address) =>
  load("balances", () => readBalances(me, store.protocol?.usdc ?? null, store.protocol?.bkrn ?? null), (v) => {
    store.balances = v;
    store.balancesOwner = me;
  });

export const loadMintable = (me: Address) => {
  const usdc = store.protocol?.usdc;
  if (!usdc) return Promise.resolve();
  return load("mintable", () => canMintTestUsdc(usdc, me), (v) => (store.mintable = v));
};

export const loadStakingProtocol = () => {
  const p = store.protocol;
  if (!p) return Promise.resolve();
  return load("stakingProtocol", () => readStakingProtocol(p), (v) => (store.stakingProtocol = v));
};

export const loadStakePosition = (me: Address) => {
  const p = store.protocol;
  if (!p) return Promise.resolve();
  return load("stakePosition", () => readStakePosition(p.staking, p.bkrn, me), (v) => {
    store.stakePosition = v;
    store.stakeOwner = me;
  });
};

/** Forget everything tied to a wallet (on disconnect / account change). */
export function clearWalletData(): void {
  store.positions = {};
  store.positionsOwner = null;
  store.balances = null;
  store.balancesOwner = null;
  store.mintable = null;
  store.stakePosition = null;
  store.stakeOwner = null;
  for (const k of ["positions", "balances", "mintable", "stakePosition"]) {
    fingerprints.delete(k);
    delete store.errors[k];
  }
}
