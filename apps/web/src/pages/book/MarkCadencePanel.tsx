// Next mark + the signed inputs the next mark relays (low-gas mode, docs/LOW_GAS.md): the oracle's latest
// signed price of the underlying and, on Orderly books, ops-venue's latest signed venue report.
import { Chip, KV, Panel } from "../../components/ui";
import type { BookDetail } from "../../lib/api-types";
import { DASH, fmtPrice, fmtUsd } from "../../lib/format";
import { SIGNED_PRICE_LINE, VENUE_REPORT_LINE, ageOf, cadenceTitle, markCadenceLine, nextMarkAt, nextMarkLabel, signedFreshness } from "../../lib/lowgas";

const TONE = { fresh: "good", aging: "warn", stale: "critical" } as const;

export function MarkCadencePanel({ b, now, maxPriceAgeSeconds = 300 }: { b: BookDetail; now: number; maxPriceAgeSeconds?: number }) {
  const s = b.markSchedule;
  const p = b.signedPrice;
  const r = b.venueReport;
  const priceAge = p ? Math.max(0, Math.floor(now / 1000) - p.publishedAtSec) : null;
  const fresh = signedFreshness(priceAge, maxPriceAgeSeconds);
  return (
    <Panel title={cadenceTitle(s.cadence)} meta={s.status === "due" ? "mark due" : `next ${nextMarkLabel(s, now)}`}>
      <KV
        rows={[
          ["Next mark", <span key="n" className="num">{`${nextMarkLabel(s, now)} · ${nextMarkAt(s)}`}</span>],
          ["Last mark period", <span key="l" className="num">{s.lastPeriodEnd ? `${new Date(s.lastPeriodEnd * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : "none yet"}</span>],
          [
            `Signed price${b.priceId ? ` (${b.priceId})` : ""}`,
            p ? (
              <span key="p" className="num inline-flex items-center gap-1.5">
                {fmtPrice(p.price)} · {ageOf(p.publishedAt, now)}
                {p.held && <Chip tone="neutral">Session closed</Chip>}
                {fresh && fresh !== "fresh" && <Chip tone={TONE[fresh]}>{fresh === "stale" ? "Stale" : "Aging"}</Chip>}
              </span>
            ) : (
              DASH
            ),
          ],
          b.venue === "orderly" && [
            "Signed venue report",
            r ? (
              <span key="r" className="num">
                {ageOf(r.asOf, now)} · exposure {fmtUsd(r.netExposureUsd, { signed: true, compact: true })}
              </span>
            ) : (
              DASH
            ),
          ],
        ]}
      />
      <p className="mt-2 text-[11px] text-muted">{markCadenceLine(s.cadence, s.intervalSeconds)}</p>
      <p className="mt-1 text-[11px] text-muted">{SIGNED_PRICE_LINE}</p>
      {b.venue === "orderly" && <p className="mt-1 text-[11px] text-muted">{VENUE_REPORT_LINE}</p>}
    </Panel>
  );
}
