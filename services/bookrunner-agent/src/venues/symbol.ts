// The Orderly symbol an agent quotes for its book (shared resolveVenueSymbol: ORDERLY_MODE + ORDERLY_BROKER_ID,
// VERIFY O19). The charter symbol stays the book's label (logs, marks, UI).
import { resolveVenueSymbol } from "@bookrunner/shared";

/** The book's charter symbol names no Orderly market (live mode). Deterministic: retrying cannot help. */
export class VenueSymbolError extends Error {
  override readonly name = "VenueSymbolError";
}

export interface VenueSymbolEnv {
  ORDERLY_MODE: "mock" | "live";
  ORDERLY_BROKER_ID: string;
}

/**
 * Venue symbol for the book (live: PERP_<T>_USDC_<broker>; mock: the charter symbol). Throws VenueSymbolError when
 * there is none; a charter symbol that breaks the charter rule but still maps is only warned about.
 */
export function agentVenueSymbol(charterSymbol: string, env: VenueSymbolEnv, warn: (warning: string) => void = () => {}): string {
  const r = resolveVenueSymbol({ charterSymbol, mode: env.ORDERLY_MODE, brokerId: env.ORDERLY_BROKER_ID });
  if (r.symbol === null) throw new VenueSymbolError(r.error);
  if (r.warning) warn(r.warning);
  return r.symbol;
}

/** Resolves once `signal` aborts (an agent that must not quote idles until shutdown instead of retrying). */
export function idleUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
