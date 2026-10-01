// Seeded PRNG (mulberry32) + distributions. Used by property tests and the trader simulator so
// that runs are reproducible from a seed.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Seed from an arbitrary string (FNV-1a 32-bit). */
export function seedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng.next();
}

export function intBetween(rng: Rng, lo: number, hi: number): number {
  return Math.floor(uniform(rng, lo, hi + 1));
}

/** Log-uniform in [lo, hi] (lo > 0): spreads samples across orders of magnitude. */
export function logUniform(rng: Rng, lo: number, hi: number): number {
  return Math.exp(uniform(rng, Math.log(lo), Math.log(hi)));
}

/** Standard normal via Box-Muller. */
export function normal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Exponential inter-arrival time with the given rate (events per unit time). */
export function exponential(rng: Rng, rate: number): number {
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  let u = 0;
  while (u === 0) u = rng.next();
  return -Math.log(u) / rate;
}

export function pick<T>(rng: Rng, xs: readonly T[]): T {
  if (xs.length === 0) throw new Error("pick: empty list");
  return xs[Math.min(xs.length - 1, Math.floor(rng.next() * xs.length))] as T;
}
