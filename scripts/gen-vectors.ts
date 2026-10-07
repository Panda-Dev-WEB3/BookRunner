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
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WAD, minBig } from "../packages/shared/src/units";
import { allocateWindow, applyMarkPnl, juniorWindowAllocation, splitDistribution } from "../packages/shared/src/waterfall";

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

const out = resolve(import.meta.dir, "../contracts/test/vectors");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "waterfall.json"), `${JSON.stringify({ count: N, window, split, mark, wallet }, null, 1)}\n`);
console.log(`wrote ${N} window / split / mark / wallet vectors to contracts/test/vectors/waterfall.json`);
