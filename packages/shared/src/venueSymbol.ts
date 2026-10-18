// Charter symbol <-> Orderly (venue) symbol, the one place every service maps between them.
//   charter symbol : what the book's charter stores (bytes32) and what marks, receipts and the UI show,
//                    e.g. "PERP_NVDA_USDC" (a plain ticker "NVDA" is read as "PERP_NVDA_USDC").
//   venue symbol   : what ops-venue, the agent and risk send to / match from Orderly (orders, cancel-all,
//                    /v1/positions, /v1/trades, insurance fund, listing).
// Orderly names builder (Perp Anything) markets PERP_<BASE>_USDC_<broker_id> (live /v1/public/info 2026-10-18:
// PERP_AAPL_USDC_mythos, PERP_ETH_USDC_testgg; docs/VERIFY.md O14 / O19); its own markets are PERP_<BASE>_USDC.
// Config (no extra knob): ORDERLY_MODE=live -> suffix "_" + ORDERLY_BROKER_ID; ORDERLY_MODE=mock -> none, the
// charter symbol verbatim (services/mock-orderly lists books under it). A book never quotes an unsuffixed
// symbol on live Orderly: that would be Orderly's own market (mainnet lists PERP_NVDA_USDC / PERP_TSLA_USDC).

export const ORDERLY_SYMBOL_QUOTE = "USDC" as const;

export interface VenueSymbolParts {
  base: string;
  quote: typeof ORDERLY_SYMBOL_QUOTE;
  /** Builder broker id of a Perp Anything market; null for Orderly's own markets. */
  broker: string | null;
}

/** Orderly broker id: lowercase alphanumerics, '_' and '-' (e.g. "bookrunner", "woofi_pro"). */
const BROKER_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Bases are uppercase alphanumerics (1000BONK), so a broker id with '_' still splits unambiguously. */
const SYMBOL_RE = /^PERP_([A-Z0-9]+)_USDC(?:_([a-z0-9][a-z0-9_-]*))?$/;

export function isOrderlyBrokerId(id: string): boolean {
  return BROKER_RE.test(id);
}

/** PERP_<BASE>_USDC[_<broker>] -> parts; null when the string is not an Orderly perp symbol. */
export function parseVenueSymbol(symbol: string): VenueSymbolParts | null {
  const m = SYMBOL_RE.exec(symbol);
  return m ? { base: m[1] as string, quote: ORDERLY_SYMBOL_QUOTE, broker: m[2] ?? null } : null;
}

export interface VenueSymbolConfig {
  mode: "mock" | "live";
  /** ORDERLY_BROKER_ID; required in live mode. */
  brokerId?: string | null;
}

/** Broker suffix the venue symbols carry under this config: the broker id in live mode, none in mock mode. */
export function symbolBroker(c: VenueSymbolConfig): string | null {
  if (c.mode !== "live") return null;
  if (!c.brokerId) throw new Error("ORDERLY_MODE=live needs ORDERLY_BROKER_ID: Orderly builder markets are PERP_<T>_USDC_<broker>");
  if (!isOrderlyBrokerId(c.brokerId)) throw new Error(`invalid Orderly broker id "${c.brokerId}" (lowercase letters, digits, '_' or '-')`);
  return c.brokerId;
}

const normalize = (s: string) => (s.startsWith("PERP_") ? s : `PERP_${s}_USDC`);

/**
 * Charter symbol -> the symbol to use on the venue. Mock mode: the charter symbol verbatim (a plain ticker becomes
 * PERP_<T>_USDC). Live mode: the book's builder market PERP_<T>_USDC_<broker>; a charter that already names that
 * market is kept, one naming another broker's market or not an Orderly perp symbol at all throws.
 */
export function venueSymbol(o: VenueSymbolConfig & { charterSymbol: string }): string {
  const broker = symbolBroker(o);
  const s = o.charterSymbol === "" ? "" : normalize(o.charterSymbol);
  if (broker === null) return s;
  const p = parseVenueSymbol(s);
  if (!p) throw new Error(`charter symbol "${o.charterSymbol}" is not an Orderly perp symbol (PERP_<BASE>_USDC)`);
  if (p.broker !== null && p.broker !== broker) throw new Error(`charter symbol "${o.charterSymbol}" names broker ${p.broker}'s market, not ${broker}'s`);
  return `PERP_${p.base}_${p.quote}_${broker}`;
}

/** Startup check (ops-venue, agents, risk): ORDERLY_MODE=live needs a valid ORDERLY_BROKER_ID. Throws otherwise. */
export function assertVenueSymbolConfig(c: VenueSymbolConfig): void {
  symbolBroker(c);
}

/**
 * Charter-time rule for Orderly-venue books, independent of ORDERLY_MODE (the API's local validation, the jury's
 * rule checks, the web form, and the services' mock-mode warning): the charter symbol must be PERP_<BASE>_USDC, or our
 * own builder market PERP_<BASE>_USDC_<brokerId>. Null when fine, else why. `brokerId` unknown: any broker suffix passes.
 */
export function orderlyCharterSymbolIssue(charterSymbol: string, brokerId?: string | null): string | null {
  const p = parseVenueSymbol(charterSymbol);
  if (!p) return `charter symbol "${charterSymbol}" is not an Orderly perp symbol (PERP_<BASE>_USDC, BASE in uppercase letters and digits)`;
  if (p.broker !== null && brokerId && p.broker !== brokerId) return `charter symbol "${charterSymbol}" names broker ${p.broker}'s market, not ${brokerId}'s`;
  return null;
}

export type VenueSymbolResolution = { symbol: string; error: null; warning: string | null } | { symbol: null; error: string; warning: null };

/**
 * Per-book mapping as the services use it (never throws). Live: the venue symbol, or `error` when the charter symbol
 * has no Orderly market (the book is then not listed / traded). Mock: the charter symbol verbatim; `warning` when it
 * breaks the charter rule, so a bad charter surfaces before the switch to live.
 */
export function resolveVenueSymbol(o: VenueSymbolConfig & { charterSymbol: string }): VenueSymbolResolution {
  const issue = orderlyCharterSymbolIssue(o.charterSymbol, o.brokerId);
  if (o.mode !== "live") return { symbol: venueSymbol(o), error: null, warning: issue ? `${issue}: it would not trade with ORDERLY_MODE=live` : null };
  try {
    return { symbol: venueSymbol(o), error: null, warning: issue };
  } catch (err) {
    return { symbol: null, error: err instanceof Error ? err.message : String(err), warning: null };
  }
}

/** Venue symbol -> charter form (broker suffix stripped); anything unparseable is returned unchanged. */
export function charterSymbolOf(symbol: string): string {
  const p = parseVenueSymbol(symbol);
  return p ? `PERP_${p.base}_${p.quote}` : symbol;
}

/** Base asset (Orderly base_ccy) of a charter or venue symbol; null when not an Orderly perp symbol. */
export function baseAssetOf(symbol: string): string | null {
  return parseVenueSymbol(symbol)?.base ?? null;
}
