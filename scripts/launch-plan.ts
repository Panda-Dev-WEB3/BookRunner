// Pure launch planning for scripts/launch-devnet.ts (testable without a chain): which books, how big, and how much
// settlement token each participant needs.
//   mock venue (devnet / the mock testnet stack): NVDA, TSLA, RHX5 at the demo sizes, participants minted mock USDC.
//   live venue (deployment record `orderly.venue = "live"`, Deploy.s.sol DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN):
//   the settlement token is REAL testnet USDG and cannot be minted, so the launch charters only the Orderly books
//   (default NVDA, TSLA) at rehearsal sizes (IF 150 > Orderly testnet's 100 requirement, MM 500) and TRANSFERS each
//   participant's need from the deployer, refusing up front when the deployer holds less (docs/RUNBOOK.md
//   "Testnet rehearsal on real Orderly", VERIFY O17: the testnet USDG source is still an open question).
// Overrides (both modes): LAUNCH_BOOKS=NVDA,TSLA,RHX5  LAUNCH_IF_USD  LAUNCH_MM_USD  LAUNCH_MAX_INVENTORY_USD (whole USD).
// A book's IF is never below the config's venueMinIf for its venue (the charter rule), RHX5's PoolEngine minimum included.

export const LAUNCH_BOOK_NAMES = ["NVDA", "TSLA", "RHX5"] as const;
export type LaunchBookName = (typeof LAUNCH_BOOK_NAMES)[number];

/** Demo sizes (whole USD) of the mock venue launch. */
export const MOCK_SIZES: Record<LaunchBookName, { ifUsd: number; mmUsd: number; maxInventoryUsd: number }> = {
  NVDA: { ifUsd: 30_000, mmUsd: 75_000, maxInventoryUsd: 50_000 },
  TSLA: { ifUsd: 30_000, mmUsd: 75_000, maxInventoryUsd: 50_000 },
  RHX5: { ifUsd: 30_000, mmUsd: 100_000, maxInventoryUsd: 75_000 },
};

/** Rehearsal sizes (whole USD) on the live venue: real USDG, Orderly testnet IF requirement > 100 per market. */
export const LIVE_SIZES = { ifUsd: 150, mmUsd: 500, maxInventoryUsd: 250 } as const;

/** Share of a book's raise (IF + MM) each participant commits: the ONE source for launchBook and settlementNeeds. */
export const COMMIT_SHARES = { sponsorJunior: 0.12, a2Junior: 0.3, a0Senior: 0.5, a1Senior: 0.4 } as const;

export interface Commit {
  who: "sponsor" | "a0" | "a1" | "a2";
  tranche: "junior" | "senior";
  /** whole USD */
  usd: number;
}

/** The subscriptions launchBook commits for a raise of `raiseUsd` whole USD (senior oversubscribed to show pro-rata). */
export function commitPlan(raiseUsd: number): Commit[] {
  return [
    { who: "sponsor", tranche: "junior", usd: Math.round(raiseUsd * COMMIT_SHARES.sponsorJunior) },
    { who: "a2", tranche: "junior", usd: Math.round(raiseUsd * COMMIT_SHARES.a2Junior) },
    { who: "a0", tranche: "senior", usd: Math.round(raiseUsd * COMMIT_SHARES.a0Senior) },
    { who: "a1", tranche: "senior", usd: Math.round(raiseUsd * COMMIT_SHARES.a1Senior) },
  ];
}

export interface BookSize {
  name: LaunchBookName;
  ifUsd: number;
  mmUsd: number;
  maxInventoryUsd: number;
  /** 2026-10: the InsurancePool funds the IF (charter.ifFromPool): the window raises only the MM inventory */
  ifFromPool?: boolean;
  /** the book's underlying for the per-market cap (books on one underlying share it); default: the book name */
  market?: string;
}

/** Whole USD the subscription window raises: the MM inventory, plus the IF when the tranches fund it. */
export const raiseOf = (s: Pick<BookSize, "ifUsd" | "mmUsd" | "ifFromPool">): number => (s.ifFromPool ? s.mmUsd : s.ifUsd + s.mmUsd);

// ---------------------------------------------------------------- insurance pool (2026-10, ARCHITECTURE §2.10)

/** InsurancePool defaults the seed is sized against (per-market cap, free-liquidity buffer). */
export const POOL_DEFAULTS = { marketCapBps: 3000, bufferBps: 2000 } as const;

/**
 * First-loss slice (whole USD) the treasury seeds so every pool-funded book's IF can be allocated at its closeWindow.
 * Queued deposits only count once their epoch is processed (after its end), so at launch the slice alone is the pool:
 * each IF must fit the per-market cap (30% of the pool; one market per launch book) and all of them the free
 * liquidity above the buffer (80%); `marginBps` of headroom on top. The slice is then 100% of the pool (>= its 10%).
 */
export function poolSeedUsd(sizes: BookSize[], o: { marketCapBps?: number; bufferBps?: number; marginBps?: number } = {}): number {
  const pooled = sizes.filter((s) => s.ifFromPool);
  if (pooled.length === 0) return 0;
  // integer bps arithmetic (whole USD): no float rounding in the seed
  const capBps = o.marketCapBps ?? POOL_DEFAULTS.marketCapBps;
  const freeBps = 10_000 - (o.bufferBps ?? POOL_DEFAULTS.bufferBps);
  // the cap is per underlying, summed over its books (review m-1)
  const byMarket = new Map<string, number>();
  for (const s of pooled) byMarket.set(s.market ?? s.name, (byMarket.get(s.market ?? s.name) ?? 0) + s.ifUsd);
  const perMarket = Math.ceil((Math.max(...byMarket.values()) * 10_000) / capBps);
  const total = Math.ceil((pooled.reduce((a, s) => a + s.ifUsd, 0) * 10_000) / freeBps);
  return Math.ceil((Math.max(perMarket, total) * (10_000 + (o.marginBps ?? 1000))) / 10_000);
}

/** Test depositors' queued deposits (whole USD) on the mock venue; none on the live venue (real USDG). */
export const POOL_TEST_DEPOSITS: ReadonlyArray<{ who: "a0" | "a1"; usd: number }> = [
  { who: "a0", usd: 60_000 },
  { who: "a1", usd: 40_000 },
];

/**
 * When the launch may queue the test deposits (review I-4). InsurancePool.setParam("epochLength") only records a PENDING
 * length; the pool applies it in _skipIdleEpochs, i.e. on the first request (or processing) made while the queue is
 * idle AND its oldest epoch has ended. The pool's first epoch ends on the weekly Unix grid set at initialize, so a deposit
 * queued before that lands in the weekly epoch. So the launch deposits only once the demo length is in force, or once
 * the first epoch has ended with an idle queue (that deposit then applies the pending length itself and lands in a
 * 1-day epoch); otherwise it defers them until `after` (re-run the launch then: it is idempotent).
 */
export function testDepositTiming(p: { nowSec: number; epochLength: number; pendingEpochLength: number; procEndsAt: number; queueIdle: boolean; demoEpochLength: number }): { deposit: true } | { deposit: false; after: number } {
  if (p.epochLength === p.demoEpochLength) return { deposit: true };
  if (p.pendingEpochLength !== p.demoEpochLength) return { deposit: true }; // demo params off: the default grid is meant
  if (p.queueIdle && p.procEndsAt <= p.nowSec) return { deposit: true };
  return { deposit: false, after: p.procEndsAt };
}

/** Devnet / testnet pool parameters set by the launch (the deployer is config.timelock() there): faster demos. */
export const POOL_DEMO_PARAMS = { epochLength: 86_400, cooldown: 3_600, processGrace: 3_600 } as const;

type Env = Record<string, string | undefined>;

function positive(env: Env, key: string): number | undefined {
  const v = env[key];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key}: not a positive whole number of USD (${v})`);
  return n;
}

/** Books to launch: LAUNCH_BOOKS, else all three on the mock venue and the two Orderly books on the live venue. */
export function launchBooks(live: boolean, env: Env = process.env): LaunchBookName[] {
  const raw = env.LAUNCH_BOOKS;
  if (!raw) return live ? ["NVDA", "TSLA"] : [...LAUNCH_BOOK_NAMES];
  const names = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const n of names) if (!(LAUNCH_BOOK_NAMES as readonly string[]).includes(n)) throw new Error(`LAUNCH_BOOKS: unknown book ${n} (${LAUNCH_BOOK_NAMES.join(", ")})`);
  if (names.length === 0) throw new Error("LAUNCH_BOOKS: empty");
  return [...new Set(names)] as LaunchBookName[];
}

/**
 * Sizes per book. `minIfUsd(venue)` is the config's venueMinIf (whole USD; 0 = Orderly, 1 = PoolEngine): the IF is
 * raised to it when the default or override is smaller (charter rule `ifTargetUsd >= venueMinIf`).
 */
export function launchSizes(live: boolean, books: LaunchBookName[], minIfUsd: (venue: 0 | 1) => number, env: Env = process.env): BookSize[] {
  const ifO = positive(env, "LAUNCH_IF_USD");
  const mmO = positive(env, "LAUNCH_MM_USD");
  const invO = positive(env, "LAUNCH_MAX_INVENTORY_USD");
  return books.map((name) => {
    const d = live ? LIVE_SIZES : MOCK_SIZES[name];
    const venue: 0 | 1 = name === "RHX5" ? 1 : 0;
    return { name, ifUsd: Math.max(ifO ?? d.ifUsd, minIfUsd(venue)), mmUsd: mmO ?? d.mmUsd, maxInventoryUsd: invO ?? d.maxInventoryUsd };
  });
}

export type Participant = "sponsor" | "a0" | "a1" | "a2";

/** Settlement token (whole USD, rounded per commit as launchBook rounds) each participant spends: commits + charter fees. */
/** A book a previous launch already started (resume): its charter fee paid, these commits made. */
export interface BookProgress {
  feePaid: boolean;
  done: ReadonlySet<Commit["who"]>;
}

/**
 * Settlement token each participant still spends: commits + charter fees, minus what a resumed book already paid
 * (`progress` by book name; launchBook skips those steps), so a resumed launch never funds a book twice.
 */
export function settlementNeeds(sizes: BookSize[], charterFeeUsd: number, progress: Readonly<Record<string, BookProgress>> = {}): Record<Participant, number> {
  const out: Record<Participant, number> = { sponsor: 0, a0: 0, a1: 0, a2: 0 };
  for (const s of sizes) {
    const pr = progress[s.name];
    if (!pr?.feePaid) out.sponsor += charterFeeUsd;
    for (const c of commitPlan(raiseOf(s))) if (!pr?.done.has(c.who)) out[c.who] += c.usd;
  }
  return out;
}

/** What the deployer must transfer: each participant's need minus what it already holds (6 dp units). */
export function transferPlan(needsUsd: Record<Participant, number>, balances: Record<Participant, bigint>): { transfers: Array<[Participant, bigint]>; total: bigint } {
  const transfers: Array<[Participant, bigint]> = [];
  let total = 0n;
  for (const p of Object.keys(needsUsd) as Participant[]) {
    const need = BigInt(Math.round(needsUsd[p] * 1e6));
    const gap = need - balances[p];
    if (gap > 0n) {
      transfers.push([p, gap]);
      total += gap;
    }
  }
  return { transfers, total };
}
