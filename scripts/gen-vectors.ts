// Generates waterfall parity vectors from the NORMATIVE TS implementation (packages/shared/src/waterfall.ts).
// contracts/test/WaterfallParity.t.sol must reproduce every row exactly.
//   bun scripts/gen-vectors.ts  -> contracts/test/vectors/waterfall.json
// Rows are arrays of decimal strings (forge: vm.parseJsonUintArray(json, ".window[i]")).
//   window: [ifTarget, mmInventory, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted,
//            ok(0|1), reason(0 ok|1 NO_JUNIOR|2 SPONSOR_SKIN|3 IF_UNFUNDED), seniorAllocated, juniorAllocated,
//            sponsorJuniorAllocated]
//   split:  [gross, expensesRequested, expenseCapBps, carryBps, seniorHurdleBps, seniorSupply, juniorSupply,
//            expenses, carry, senior, junior]
//   mark:   [S, J, seniorImpairment, perfIndex, highWater, nav, juniorSupply, backstopAvailable,
//            S', J', seniorImpairment', perfIndex', highWater', backstopCovered, |drawdownBps|,
//            backstopDebt, backstopRepaid, backstopDebt'] (debt columns appended; derived from the row index
//            so the earlier columns keep their RNG stream)
//   wallet: [commit, isSponsor(0|1), totalCommitted, sponsorCommitted, totalAllocated, shares, refund]
//            (juniorWindowAllocation: Junior window settlement with sponsor priority)
//   credit: [senior, junior, juniorSupply, seniorImpairment, backstopDebt, seniorCredit, juniorCredit,
//            seniorRestored, backstopRepaid, seniorImpairment', backstopDebt'] (applyDistribution, audit L-1;
//            generated after the sections above so they keep their RNG stream)
// Insurance pool (2026-10; generated after credit, same reason):
//   premium:    [gross, charterPremiumBps, floorBps, expensesRequested, expenseCapBps, carryBps, seniorHurdleBps,
//                seniorSupply, juniorSupply, effectivePremiumBps, premium, expenses, carry, senior, junior]
//   poolCredit: [senior, junior, juniorSupply, imp, impIf, backstopDebt, coverHeld, poolShortfall, | seniorCredit,
//                juniorCredit, poolRestored, seniorRestored, backstopRepaid, imp', impIf', backstopDebt', coverHeld',
//                juniorIfLoss, juniorIfLoss'] (juniorIfLoss appended, derived from the row index: no RNG draw)
//               (applyPoolDistribution, pool audit 2026-10-23 B-L2: an exhausted book's fee flow restores the claim first)
//   poolMark:   [S, J, imp, impIf, juniorIfLoss, coverHeld, backstopDebt, perfIndex, highWater, poolValue, poolDebt,
//                ifDraw, netAssets, insuranceEquity, due(0|1), juniorSupply, backstopAvailable, | S', J', imp', impIf',
//                juniorIfLoss', coverHeld', backstopDebt', perfIndex', highWater', poolValue', ifDraw', nav,
//                |drawdownBps|, juniorLoss, seniorLoss, seniorIfLoss, poolLoss, poolRestored, seniorRestored, juniorGain,
//                backstopRepaid, backstopCovered] (applyPoolMarkPnl: the explicit insurance ledger, pool audit 2026-10-23)
//   poolWindow: [ifTarget, mmInventory, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted,
//                ok, reason, seniorAllocated, juniorAllocated, ifRaised(0), mmAmount, idle, minOwnCapitalBps,
//                capitalOk(0|1)] (window with ifFromPool; poolCapitalOk, pool audit 2026-10-23 B-M2)
//   poolBook:   end-to-end pool-funded book (POOL_BOOK_N rows; contracts/test/pool/PoolBookParity.t.sol runs each
//               through Book + InsurancePool + RevenueRouter). Fixed: seniorCapBps 7000, seniorHurdleBps 6000,
//               expenseCapBps 2000, carryBps 1000, the sponsor commits all of Junior, premiumBps already effective
//               (max(sponsor, floor 1200), as MarketCharter files it). An IF draw (ifLoss) is a book loss.
//               [seniorCommitted, juniorCommitted, ifTarget, mmInventory, gross, expensesRequested, premiumBps,
//                ifLoss, mmLoss(0|1), mmPnlAbs, | seniorAllocated, juniorAllocated, premium, expenses, carry, senior,
//                junior, seniorCredit, juniorCredit, poolValue, nav, S', J']
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WAD, minBig } from "../packages/shared/src/units";
import {
  allocateWindow,
  applyDistribution,
  applyMarkPnl,
  effectivePremiumBps,
  initialDeployment,
  juniorWindowAllocation,
  applyPoolDistribution,
  applyPoolMarkPnl,
  poolCapitalOk,
  splitDistribution,
  splitPoolDistribution,
  windowIfTarget,
} from "../packages/shared/src/waterfall";

let seed = 0x5eed_b00cn;
function rnd(max: bigint): bigint {
  // xorshift64*
  seed ^= seed << 13n;
  seed &= (1n << 64n) - 1n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n;
  seed &= (1n << 64n) - 1n;
  return max === 0n ? 0n : seed % (max + 1n);
}
const pick = <T,>(xs: T[]): T => xs[Number(rnd(BigInt(xs.length - 1)))]!;
const mag = () => pick([0n, 1n, 999n, 10n ** 6n, 25_000n * 10n ** 6n, 10n ** 12n, 10n ** 15n]);
const amt = () => (rnd(3n) === 0n ? mag() : rnd(mag() * 3n + 1n));

const REASON = { NO_JUNIOR: 1, SPONSOR_SKIN: 2, IF_UNFUNDED: 3 } as const;
const N = 256;
const window: string[][] = [];
const split: string[][] = [];
const mark: string[][] = [];
const wallet: string[][] = [];
const credit: string[][] = [];

for (let i = 0; i < N; i++) {
  const ifTargetUsd = amt();
  const mmInventoryUsd = amt();
  const seniorCapBps = pick([0n, 1n, 5000n, 7000n, 9000n, 9999n, 10_000n]);
  const seniorCommitted = amt();
  const juniorCommitted = amt();
  const sponsorJuniorCommitted = rnd(1n) === 0n ? (juniorCommitted * pick([0n, 999n, 1000n, 1001n, 10_000n])) / 10_000n : rnd(juniorCommitted);
  const r = allocateWindow({ ifTargetUsd, mmInventoryUsd, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted });
  window.push([ifTargetUsd, mmInventoryUsd, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted, r.ok ? 1n : 0n, BigInt(r.reason ? REASON[r.reason] : 0), r.seniorAllocated, r.juniorAllocated, r.sponsorJuniorAllocated].map(String));
}

for (let i = 0; i < N; i++) {
  const inp = {
    gross: amt(),
    expensesRequested: amt(),
    expenseCapBps: pick([0n, 500n, 2000n, 10_000n]),
    carryBps: pick([0n, 1000n, 2500n]),
    seniorHurdleBps: pick([0n, 3000n, 6000n, 10_000n]),
    seniorSupply: pick([0n, 1n, 10n ** 9n]),
    juniorSupply: pick([0n, 1n, 10n ** 9n]),
  };
  const o = splitDistribution(inp);
  split.push([inp.gross, inp.expensesRequested, inp.expenseCapBps, inp.carryBps, inp.seniorHurdleBps, inp.seniorSupply, inp.juniorSupply, o.expenses, o.carry, o.senior, o.junior].map(String));

  const S = amt();
  const J = rnd(2n) === 0n ? 0n : amt();
  const imp = rnd(2n) === 0n ? 0n : amt();
  const perfIndex = pick([WAD, (WAD * 9n) / 10n, WAD * 2n, 1n]);
  const highWater = perfIndex + pick([0n, 0n, WAD / 10n]);
  const accounted = S + J;
  const nav = pick([0n, accounted, accounted / 2n, (accounted * 11n) / 10n, accounted + amt(), rnd(accounted)]);
  const juniorSupply = J === 0n ? pick([0n, 1n]) : pick([1n, 10n ** 9n]);
  const backstopAvailable = amt();
  // no RNG draw: 0 / below / above the gain / the impairment, by row index
  const backstopDebt = [0n, 0n, 1n, (S + J) / 20n, imp, backstopAvailable][i % 6]!;
  const m = applyMarkPnl({ seniorNav: S, juniorNav: J, seniorImpairment: imp, perfIndex, highWater, backstopDebt }, { nav, juniorSupply, backstopAvailable });
  mark.push([S, J, imp, perfIndex, highWater, nav, juniorSupply, backstopAvailable, m.seniorNav, m.juniorNav, m.seniorImpairment, m.perfIndex, m.highWater, m.backstopCovered, -m.drawdownBps, backstopDebt, m.backstopRepaid, m.backstopDebt].map(String));
}

// Junior window wallet settlement (generated last so the rows above keep their inputs). Domain as on
// chain: sponsorCommitted <= totalCommitted, totalAllocated <= totalCommitted, the sponsor's commit equals
// sponsorCommitted and any other wallet's commit is part of the non-sponsor commitments.
for (let i = 0; i < N; i++) {
  const totalCommitted = amt();
  const sponsorCommitted = pick([0n, totalCommitted, totalCommitted / 10n, totalCommitted / 11n, rnd(totalCommitted)]);
  const totalAllocated = pick([totalCommitted, 0n, sponsorCommitted, minBig(totalCommitted, sponsorCommitted * 10n), rnd(totalCommitted)]);
  const isSponsor = rnd(2n) === 0n && sponsorCommitted > 0n;
  const commit = isSponsor ? sponsorCommitted : rnd(totalCommitted - sponsorCommitted);
  const w = juniorWindowAllocation(commit, isSponsor, totalCommitted, sponsorCommitted, totalAllocated);
  wallet.push([commit, isSponsor ? 1n : 0n, totalCommitted, sponsorCommitted, totalAllocated, w.shares, w.refund].map(String));
}

// Fee-flow credit (Book.creditDistribution, audit L-1): residual order Senior impairment -> backstop debt ->
// Junior. Covers no impairment / no debt, residual below / between / above both, and no Junior supply.
for (let i = 0; i < N; i++) {
  const senior = amt();
  const junior = rnd(4n) === 0n ? 0n : amt();
  const juniorSupply = pick([0n, 1n, 10n ** 9n, 10n ** 9n]);
  const seniorImpairment = rnd(2n) === 0n ? 0n : pick([amt(), junior / 2n, junior, junior + 1n]);
  const backstopDebt = rnd(2n) === 0n ? 0n : pick([amt(), junior, 1n]);
  const c = applyDistribution({ senior, junior, juniorSupply, seniorImpairment, backstopDebt });
  credit.push([senior, junior, juniorSupply, seniorImpairment, backstopDebt, c.seniorCredit, c.juniorCredit, c.seniorRestored, c.backstopRepaid, c.seniorImpairment, c.backstopDebt].map(String));
}

// ---- insurance pool (2026-10; ledger rows: pool audit 2026-10-23) ----
const premium: string[][] = [];
const poolCredit: string[][] = [];
const poolWindow: string[][] = [];
const poolBook: string[][] = [];

for (let i = 0; i < N; i++) {
  const inp = {
    gross: amt(),
    expensesRequested: amt(),
    expenseCapBps: pick([0n, 500n, 2000n, 10_000n]),
    carryBps: pick([0n, 1000n, 2500n]),
    seniorHurdleBps: pick([0n, 3000n, 6000n, 10_000n]),
    seniorSupply: pick([0n, 1n, 10n ** 9n]),
    juniorSupply: pick([0n, 1n, 10n ** 9n]),
  };
  const charterBps = pick([0n, 1n, 1199n, 1200n, 2500n, 5000n, 10_000n]);
  const floorBps = pick([0n, 1200n, 5000n]);
  const bps = effectivePremiumBps(charterBps, floorBps);
  const o = splitPoolDistribution(inp, bps);
  premium.push([inp.gross, charterBps, floorBps, inp.expensesRequested, inp.expenseCapBps, inp.carryBps, inp.seniorHurdleBps, inp.seniorSupply, inp.juniorSupply, bps, o.premium, o.expenses, o.carry, o.senior, o.junior].map(String));

  // fee flow on the ledger (B-L2): an exhausted book's credit restores the pool's claim first
  const senior = amt();
  const junior = rnd(4n) === 0n ? 0n : amt();
  const juniorSupply = pick([0n, 1n, 10n ** 9n]);
  const seniorImpairment = rnd(2n) === 0n ? 0n : amt();
  const seniorIfImpairment = rnd(2n) === 0n ? 0n : rnd(seniorImpairment);
  const backstopDebt = rnd(2n) === 0n ? 0n : amt();
  const coverHeld = rnd(backstopDebt);
  const poolShortfall = rnd(2n) === 0n ? 0n : pick([amt(), junior, senior + junior, 1n]);
  const juniorIfLoss = i % 3 === 0 ? 0n : (junior * BigInt(i % 7)) / 3n; // no RNG draw: keeps the stream
  const c = applyPoolDistribution({ senior, junior, juniorSupply, seniorImpairment, seniorIfImpairment, backstopDebt, coverHeld, juniorIfLoss, poolShortfall });
  poolCredit.push([senior, junior, juniorSupply, seniorImpairment, seniorIfImpairment, backstopDebt, coverHeld, poolShortfall, c.seniorCredit, c.juniorCredit, c.poolRestored, c.seniorRestored, c.backstopRepaid, c.seniorImpairment, c.seniorIfImpairment, c.backstopDebt, c.coverHeld, juniorIfLoss, c.juniorIfLoss].map(String));

  const ifTargetUsd = amt();
  const mmInventoryUsd = amt();
  const seniorCapBps = pick([0n, 1n, 5000n, 7000n, 9000n, 9999n, 10_000n]);
  const seniorCommitted = amt();
  const juniorCommitted = amt();
  const sponsorJuniorCommitted = rnd(1n) === 0n ? (juniorCommitted * pick([0n, 999n, 1000n, 1001n, 10_000n])) / 10_000n : rnd(juniorCommitted);
  const raised = windowIfTarget(ifTargetUsd, true);
  const w = allocateWindow({ ifTargetUsd: raised, mmInventoryUsd, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted });
  const d = initialDeployment(w.seniorAllocated + w.juniorAllocated, raised, mmInventoryUsd);
  const minOwnCapitalBps = pick([0n, 1n, 5000n, 10_000n, 20_000n]);
  const capitalOk = poolCapitalOk(w.seniorAllocated + w.juniorAllocated, ifTargetUsd, minOwnCapitalBps);
  poolWindow.push([ifTargetUsd, mmInventoryUsd, seniorCapBps, seniorCommitted, juniorCommitted, sponsorJuniorCommitted, w.ok ? 1n : 0n, BigInt(w.reason ? REASON[w.reason] : 0), w.seniorAllocated, w.juniorAllocated, d.ifAmount, d.mmAmount, d.idle, minOwnCapitalBps, capitalOk ? 1n : 0n].map(String));
}

// Pool-funded book marks on the explicit ledger (owner ruling N-1, cumulative): the IF draw is never covered, the
// cover is never own capital, gains repay the Backstop before Senior's IF impairment. States satisfy the book's
// invariants: coverHeld <= min(S, backstopDebt), seniorIfImpairment <= seniorImpairment, poolValue <= poolDebt and a
// shortfall only with no tranche own capital (J == 0, S == coverHeld).
const poolMark: string[][] = [];
for (let i = 0; i < N; i++) {
  const U6 = 10n ** 6n;
  let S = rnd(100_000n) * U6;
  let J = rnd(2n) === 0n ? 0n : rnd(50_000n) * U6;
  const seniorImpairment = rnd(2n) === 0n ? 0n : rnd(60_000n) * U6;
  const seniorIfImpairment = rnd(2n) === 0n ? 0n : rnd(seniorImpairment);
  const juniorIfLoss = rnd(2n) === 0n ? 0n : rnd(30_000n) * U6;
  const backstopDebt = rnd(2n) === 0n ? 0n : rnd(S + 10_000n * U6);
  const coverHeld = rnd(2n) === 0n ? 0n : rnd(minBig(S, backstopDebt));
  const perfIndex = pick([WAD, (WAD * 9n) / 10n, WAD * 2n]);
  const highWater = perfIndex + pick([0n, WAD / 10n]);
  const poolDebt = rnd(40_000n) * U6;
  let poolValue = poolDebt;
  if (rnd(3n) === 0n) {
    poolValue = rnd(poolDebt); // exhausted: no tranche own capital
    J = 0n;
    S = coverHeld;
  }
  const ifDraw = pick([0n, rnd(poolDebt), poolDebt]);
  const held = S + J + poolValue;
  const netAssets = pick([0n, held, rnd(held), held + rnd(50_000n * U6), held - minBig(held, rnd(30_000n * U6))]);
  const insuranceEquityUsd = pick([0n, poolDebt, rnd(poolDebt), poolDebt + rnd(5_000n * U6), poolDebt - minBig(poolDebt, ifDraw)]);
  const due = rnd(3n) === 0n;
  const juniorSupply = J === 0n ? pick([0n, 1n]) : 10n ** 9n;
  const backstopAvailable = pick([0n, rnd(200_000n) * U6, 10n ** 15n]);
  const st = { seniorNav: S, juniorNav: J, seniorImpairment, seniorIfImpairment, juniorIfLoss, coverHeld, backstopDebt, perfIndex, highWater, poolValue, poolDebt, ifDraw };
  const r = applyPoolMarkPnl(st, { netAssets, insuranceEquityUsd, due, juniorSupply, backstopAvailable });
  const o = r.s;
  poolMark.push([S, J, seniorImpairment, seniorIfImpairment, juniorIfLoss, coverHeld, backstopDebt, perfIndex, highWater, poolValue, poolDebt, ifDraw, netAssets, insuranceEquityUsd, due ? 1n : 0n, juniorSupply, backstopAvailable, o.seniorNav, o.juniorNav, o.seniorImpairment, o.seniorIfImpairment, o.juniorIfLoss, o.coverHeld, o.backstopDebt, o.perfIndex, o.highWater, o.poolValue, o.ifDraw, r.nav, -r.drawdownBps, r.juniorLoss, r.seniorLoss, r.seniorIfLoss, r.poolLoss, r.poolRestored, r.seniorRestored, r.juniorGain, r.backstopRepaid, r.backstopCovered].map(String));
}

// End-to-end pool-funded book (realistic magnitudes; every window succeeds: the sponsor commits all of Junior, and the
// raise covers the pool's 50% minimum own capital).
const POOL_BOOK_N = 32;
const U = 10n ** 6n;
for (let i = 0; i < POOL_BOOK_N; i++) {
  const seniorCommitted = rnd(200_000n) * U;
  const ifTargetUsd = (rnd(40_000n) + 10_000n) * U;
  const juniorCommitted = (rnd(99_999n) + 1n) * U + ifTargetUsd / 2n;
  const mmInventoryUsd = (rnd(140_000n) + 10_000n) * U + ifTargetUsd / 2n;
  const gross = pick([0n, 1n, rnd(20_000n * U)]);
  const expensesRequested = pick([0n, rnd(5_000n * U)]);
  const premiumBps = effectivePremiumBps(pick([0n, 500n, 1200n, 2000n, 5000n]), 1200n);
  const ifLoss = pick([0n, ifTargetUsd, rnd(ifTargetUsd)]);
  const mmLoss = rnd(1n) === 0n;
  const w = allocateWindow({ ifTargetUsd: windowIfTarget(ifTargetUsd, true), mmInventoryUsd, seniorCapBps: 7000n, seniorCommitted, juniorCommitted, sponsorJuniorCommitted: juniorCommitted });
  if (!w.ok || !poolCapitalOk(w.seniorAllocated + w.juniorAllocated, ifTargetUsd, 5000n)) throw new Error("poolBook window must succeed");
  const total = w.seniorAllocated + w.juniorAllocated;
  const dep = initialDeployment(total, 0n, mmInventoryUsd);
  const mmPnlAbs = rnd(dep.mmAmount);
  const s = splitPoolDistribution(
    { gross, expensesRequested, expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 6000n, seniorSupply: w.seniorAllocated, juniorSupply: w.juniorAllocated },
    premiumBps,
  );
  const cr = applyPoolDistribution({ senior: s.senior, junior: s.junior, juniorSupply: w.juniorAllocated, seniorImpairment: 0n, seniorIfImpairment: 0n, backstopDebt: 0n, coverHeld: 0n, juniorIfLoss: 0n, poolShortfall: 0n });
  const ifEquity = ifTargetUsd - ifLoss;
  const mmValue = mmLoss ? dep.mmAmount - mmPnlAbs : dep.mmAmount + mmPnlAbs;
  const vaultIdle = dep.idle + s.senior + s.junior;
  const deployed = ifEquity + mmValue;
  const m = applyPoolMarkPnl(
    { seniorNav: w.seniorAllocated + cr.seniorCredit, juniorNav: w.juniorAllocated + cr.juniorCredit, seniorImpairment: 0n, seniorIfImpairment: 0n, juniorIfLoss: 0n, coverHeld: 0n, backstopDebt: 0n, perfIndex: WAD, highWater: WAD, poolValue: ifTargetUsd, poolDebt: ifTargetUsd, ifDraw: 0n },
    { netAssets: vaultIdle + deployed, insuranceEquityUsd: minBig(ifEquity, deployed), due: false, juniorSupply: w.juniorAllocated, backstopAvailable: 0n },
  );
  poolBook.push([seniorCommitted, juniorCommitted, ifTargetUsd, mmInventoryUsd, gross, expensesRequested, premiumBps, ifLoss, mmLoss ? 1n : 0n, mmPnlAbs, w.seniorAllocated, w.juniorAllocated, s.premium, s.expenses, s.carry, s.senior, s.junior, cr.seniorCredit, cr.juniorCredit, m.s.poolValue, m.nav, m.s.seniorNav, m.s.juniorNav].map(String));
}

const out = resolve(import.meta.dir, "../contracts/test/vectors");
mkdirSync(out, { recursive: true });
writeFileSync(
  resolve(out, "waterfall.json"),
  `${JSON.stringify({ count: N, window, split, mark, wallet, credit, premium, poolCredit, poolMark, poolWindow, poolBookCount: POOL_BOOK_N, poolBook }, null, 1)}\n`,
);
console.log(`wrote ${N} window / split / mark / wallet / credit / premium / poolCredit / poolMark / poolWindow and ${POOL_BOOK_N} poolBook vectors to contracts/test/vectors/waterfall.json`);
