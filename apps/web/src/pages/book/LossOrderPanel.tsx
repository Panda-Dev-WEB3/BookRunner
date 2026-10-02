import { useState } from "react";
import { EmptyState, KV, Panel, ValueKind } from "../../components/ui";
import { BACKSTOP_LINE, TRANCHE_COPY } from "../../lib/copy";
import { fmtBps, fmtUsd, usdRaw } from "../../lib/format";
import { frac, illustrateLoss } from "../../lib/waterfall";

export function LossOrderPanel(props: { seniorNavUsd: string | null; juniorNavUsd: string | null; killAtDrawdownBps: number | null }) {
  const S = usdRaw(props.seniorNavUsd) ?? 0n;
  const J = usdRaw(props.juniorNavUsd) ?? 0n;
  const total = S + J;
  const [pct, setPct] = useState(0);
  if (total === 0n) {
    return (
      <Panel title="Loss order" actions={<ValueKind kind="marked" />}>
        <EmptyState compact title="No tranche NAV yet" body="Loss order applies once the window closes: Junior absorbs losses first, then Senior, then the backstop up to the pool." />
      </Panel>
    );
  }
  const loss = (total * BigInt(Math.round(pct * 100))) / 10_000n;
  const r = illustrateLoss(S, J, loss, null);
  // bar: Junior (first loss) | Senior | Backstop (indeterminate, hatched)
  const jw = frac(J, total) * 82;
  const sw = frac(S, total) * 82;
  const killed = props.killAtDrawdownBps !== null && r.drawdownBps <= props.killAtDrawdownBps && pct > 0;

  return (
    <Panel title="Loss order" meta="Junior, then Senior, then backstop" actions={<ValueKind kind="marked" />}>
      <ol className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        <li>
          <span className="num mr-1 text-muted">1</span>Junior absorbs first
        </li>
        <li>
          <span className="num mr-1 text-muted">2</span>Senior absorbs next
        </li>
        <li>
          <span className="num mr-1 text-muted">3</span>Backstop up to the pool
        </li>
      </ol>
      <div className="relative flex h-9 w-full gap-[2px]" role="img" aria-label="Capital in loss order">
        <div className="relative h-full overflow-hidden rounded-l-[2px] bg-junior/25" style={{ width: `${jw}%` }} title="Junior NAV">
          <div className="absolute inset-y-0 left-0 bg-junior" style={{ width: `${J > 0n ? frac(r.juniorLoss, J) * 100 : 0}%` }} />
          <span className="absolute inset-0 flex items-center px-2 text-[11px] font-semibold text-ink">Junior</span>
        </div>
        <div className="relative h-full overflow-hidden bg-senior/25" style={{ width: `${sw}%` }} title="Senior NAV">
          <div className="absolute inset-y-0 left-0 bg-senior" style={{ width: `${S > 0n ? frac(r.seniorLoss, S) * 100 : 0}%` }} />
          <span className="absolute inset-0 flex items-center px-2 text-[11px] font-semibold text-ink">Senior</span>
        </div>
        <div className="hatch relative h-full flex-1 rounded-r-[2px] border border-line-strong" title="Backstop up to the pool">
          <span className="absolute inset-0 flex items-center px-1.5 text-[10.5px] font-semibold text-ink-2">Backstop</span>
        </div>
      </div>
      <div className="mt-3">
        <label className="flex items-center justify-between text-[12px]" htmlFor="loss-slider">
          <span className="text-ink-2">Illustrate a mark loss of</span>
          <span className="num font-medium">
            {fmtUsd(r.loss, { compact: true, symbol: true })} · {pct.toFixed(1)}% of NAV
          </span>
        </label>
        <input
          id="loss-slider"
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={pct}
          onChange={(e) => setPct(Number(e.currentTarget.value))}
          className="mt-1 w-full accent-[var(--accent)]"
        />
      </div>
      <KV
        className="mt-2"
        rows={[
          ["Junior absorbs", fmtUsd(r.juniorLoss)],
          ["Senior absorbs", fmtUsd(r.seniorLoss)],
          ["Eligible for backstop cover", r.backstopEligible > 0n ? `${fmtUsd(r.backstopEligible)} (up to the pool)` : fmtUsd(0n)],
          ["Drawdown of the book", `${fmtBps(r.drawdownBps)}${killed ? " · at or past the kill threshold" : ""}`],
        ]}
      />
      <div className="mt-3 space-y-1 text-[11px] text-muted">
        <p>
          <span className="font-semibold text-ink-2">Junior.</span> {TRANCHE_COPY.junior.line}
        </p>
        <p>
          <span className="font-semibold text-ink-2">Senior.</span> {TRANCHE_COPY.senior.line}
        </p>
        <p>{BACKSTOP_LINE} Illustration only, computed with the protocol's waterfall math on the last marked tranche NAVs.</p>
      </div>
    </Panel>
  );
}
