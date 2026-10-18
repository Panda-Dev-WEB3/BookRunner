// primary-confirm aggregation (mainnet policy, ORACLE_POLICY=primary-confirm):
//   - the primary source (Chainlink, per share) alone sets the price: no fresh primary observation = no price
//     (ok false; the session hold / skip logic applies, a confirm source NEVER substitutes for it);
//   - every other fresh observation (the Uniswap v3 TWAP, optionally Pyth / HTTP) is a confirmer: compared with the
//     primary, |confirmer - primary| / primary > confirmBps = "diverged" (the primary is STILL the price: the caller
//     warns and /health + services/alerts report it); no fresh confirmer = "unavailable" (published unconfirmed);
//   - the signed update counts ONE source (sourceCount 1, on-chain AttestedOracle.minSources() = 1), while its
//     sourcesHash commits to the primary AND every fresh confirmer (`attested`), so anyone holding the message can
//     see what the price was confirmed against.
import { type AggregateOptions, type AggregateResult, type CollectedQuote, type ConfirmResult, deviationBps, exceedsBps, freshQuotes } from "./aggregate";
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
      confirm: { status: "no-primary", diffBps: null, primaryPrice: null, confirmers: [] },
    };
  }
  const confirmers = others.map((q) => ({ name: q.name, price: q.price, ts: q.ts, diffBps: deviationBps(q.price, primary.price) }));
  const diverged = others.some((q) => exceedsBps(q.price, primary.price, o.confirmBps));
  const confirm: ConfirmResult = {
    status: confirmers.length === 0 ? "unavailable" : diverged ? "diverged" : "ok",
    diffBps: confirmers.length === 0 ? null : Math.max(...confirmers.map((c) => c.diffBps)),
    primaryPrice: primary.price,
    confirmers,
  };
  const attested: SourceQuote[] = [primary, ...others];
  return { ok: true, price: primary.price, accepted: [primary], rejected, sourceCount: 1, attested, confirm };
}
