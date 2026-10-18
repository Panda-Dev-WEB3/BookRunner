// primary-confirm aggregation (mainnet policy, ORACLE_POLICY=primary-confirm):
//   - the primary source (Chainlink, per share) alone sets the price: no fresh primary observation = no price
//     (ok false; the session hold / skip logic applies, a confirm source NEVER substitutes for it);
//   - every other fresh observation (the Uniswap v3 TWAP, optionally Pyth / HTTP) is a confirmer: compared with the
//     primary, |confirmer - primary| / primary > confirmBps = "diverged" (the primary is STILL the price: the caller
//     warns and /health + services/alerts report it); no fresh confirmer = "unavailable" (published unconfirmed);
//   - the signed update counts ONE source (sourceCount 1, on-chain AttestedOracle.minSources() = 1), while its
//     sourcesHash commits to the primary AND every fresh confirmer (`attested`), so anyone holding the message can
//     see what the price was confirmed against.
import { type AggregateOptions, type AggregateResult, type CollectedQuote, type ConfirmResult, type ConfirmStatus, deviationBps, exceedsBps, freshQuotes } from "./aggregate";
import type { SourceQuote } from "./types";

export interface PrimaryConfirmOptions extends Pick<AggregateOptions, "nowMs" | "maxAgeMs" | "maxFutureMs"> {
  /** name of the signing source (PRIMARY_SOURCE, "chainlink") */
  primary: string;
  /** divergence threshold (bps of the primary price), ORACLE_CONFIRM_BPS */
  confirmBps: number;
}

export function primaryConfirm(quotes: readonly CollectedQuote[], o: PrimaryConfirmOptions): AggregateResult & { confirm: ConfirmResult } {
  const { fresh, rejected } = freshQuotes(quotes, o);
  const primary = fresh.find((q) => q.name === o.primary);
  const others = fresh.filter((q) => q.name !== o.primary).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!primary) {
    const why = rejected.find((r) => r.name === o.primary)?.reason;
    return {
      ok: false,
      price: null,
      accepted: [],
      rejected,
      reason: `primary source ${o.primary} has no ${why === "stale" ? "fresh " : why === "invalid" ? "valid " : ""}observation (confirm sources never substitute for it)`,
      confirm: { status: "no-primary", diffBps: null, primaryPrice: null, primaryTs: null, confirmers: [] },
    };
  }
  const confirmers = others.map((q) => ({ name: q.name, price: q.price, ts: q.ts, diffBps: deviationBps(q.price, primary.price) }));
  const diverged = others.some((q) => exceedsBps(q.price, primary.price, o.confirmBps));
  const confirm: ConfirmResult = {
    status: confirmers.length === 0 ? "unavailable" : diverged ? "diverged" : "ok",
    diffBps: confirmers.length === 0 ? null : Math.max(...confirmers.map((c) => c.diffBps)),
    primaryPrice: primary.price,
    primaryTs: primary.ts,
    confirmers,
  };
  const attested: SourceQuote[] = [primary, ...others];
  return { ok: true, price: primary.price, accepted: [primary], rejected, sourceCount: 1, attested, confirm };
}

/** Per-ticker run of a confirm status, with hysteresis (service.ts keeps one per equity; /health shows it). */
export interface ConfirmRun {
  /** sticky status: a diverged / unavailable run ends only once another status held for hysteresisMs */
  status: ConfirmStatus | "closed";
  /** start (unix ms) of the run */
  since: number;
  /** the other status seen since (unix ms), not yet held long enough to end the run */
  pending: { status: ConfirmStatus | "closed"; since: number } | null;
  /**
   * start (unix ms) of the run in which the confirm gap exceeds lagBps (with the same hysteresis); with no Chainlink
   * round since then this is the signature of a feed that silently stopped updating (alerts oracle_primary_suspect_stale)
   */
  lagSince: number | null;
  lagClearSince: number | null;
}

const STICKY: ReadonlySet<string> = new Set(["diverged", "unavailable"]);

/**
 * Next run state of one ticker. Off-hours (`open` false) is "closed" immediately and ends every run. Entering diverged /
 * unavailable is immediate; leaving it needs the other status for `hysteresisMs` (a one-tick flap around the threshold
 * or a DEX blip keeps the run and its `since`, so the alert timers are not reset). The lag run works the same way on
 * `diffBps > lagBps` (Chainlink present).
 */
export function nextConfirmRun(
  prev: ConfirmRun | null,
  c: Pick<ConfirmResult, "status" | "diffBps" | "primaryPrice">,
  open: boolean,
  nowMs: number,
  o: { hysteresisMs: number; lagBps: number },
): ConfirmRun {
  const raw: ConfirmRun["status"] = open ? c.status : "closed";
  let { status, since, pending } = prev ?? { status: raw, since: nowMs, pending: null };
  if (raw === status) pending = null;
  else if (raw !== "closed" && STICKY.has(status)) {
    if (!pending || pending.status !== raw) pending = { status: raw, since: nowMs };
    if (nowMs - pending.since >= o.hysteresisMs) {
      status = raw;
      since = pending.since;
      pending = null;
    }
  } else {
    status = raw;
    since = nowMs;
    pending = null;
  }

  const lagging = open && c.primaryPrice !== null && c.diffBps !== null && c.diffBps > o.lagBps;
  let lagSince = prev?.lagSince ?? null;
  let lagClearSince = prev?.lagClearSince ?? null;
  if (!open) {
    lagSince = null;
    lagClearSince = null;
  } else if (lagging) {
    lagSince ??= nowMs;
    lagClearSince = null;
  } else if (lagSince !== null) {
    lagClearSince ??= nowMs;
    if (nowMs - lagClearSince >= o.hysteresisMs) {
      lagSince = null;
      lagClearSince = null;
    }
  }
  return { status, since, pending, lagSince, lagClearSince };
}
