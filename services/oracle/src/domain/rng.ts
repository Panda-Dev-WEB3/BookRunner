// Counter-based deterministic PRNG: every draw is a pure function of (seed, ticker, step, stream),
// so any point of a path can be reproduced without shared mutable generator state.

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** MurmurHash3 fmix32 finaliser. */
export function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mixes a key and integer coordinates into one 32-bit value. */
export function mix(key: number, ...coords: number[]): number {
  let h = fmix32(key ^ 0x9e3779b9);
  for (const c of coords) {
    // split doubles beyond 32 bits so large step counters stay distinct
    const lo = c >>> 0;
    const hi = Math.floor(c / 4294967296) >>> 0;
    h = fmix32(h ^ fmix32(lo + 0x7f4a7c15));
    h = fmix32(h ^ fmix32(hi + 0x165667b1));
  }
  return h;
}

/** Uniform in the open interval (0, 1). */
export function uniform(key: number, ...coords: number[]): number {
  return (mix(key, ...coords) + 0.5) / 4294967296;
}

/** Standard normal via Box-Muller over two independent uniforms. */
export function normal(key: number, ...coords: number[]): number {
  const u1 = uniform(key, ...coords, 0x51ed);
  const u2 = uniform(key, ...coords, 0x2e9b);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A source of independent standard normals (the synthetic market's per-step entropy). */
export type NormalSource = () => number;

/** Uniform in (0, 1) from the platform CSPRNG (crypto.getRandomValues): never reproducible. */
export function csprngUniform(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! + 0.5) / 4294967296;
}

/** Standard normal from the platform CSPRNG (Box-Muller). */
export const csprngNormal: NormalSource = () => Math.sqrt(-2 * Math.log(csprngUniform())) * Math.cos(2 * Math.PI * csprngUniform());
