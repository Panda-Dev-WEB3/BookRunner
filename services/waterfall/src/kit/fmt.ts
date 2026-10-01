import { USD_DECIMALS, formatFixed } from "@bookrunner/shared";

/** Raw 6dp -> fixed 6-decimal string ("-12.345600"); used in event payloads and mark JSON. */
export function usd6(raw: bigint): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const i = v / 1_000_000n;
  const f = (v % 1_000_000n).toString().padStart(USD_DECIMALS, "0");
  return `${neg ? "-" : ""}${i}.${f}`;
}

/** WAD -> fixed 18-decimal string. */
export function wad18(raw: bigint): string {
  const s = formatFixed(raw, 18);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(18, "0")}`;
}

export const toJsonSafe = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
