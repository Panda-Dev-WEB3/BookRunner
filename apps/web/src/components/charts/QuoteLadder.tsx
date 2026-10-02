// Vertical price ladder: the oracle, the mandate's allowed-mid band (oracle +/- max skew), the
// minimum-width bracket around the mid, and the live bid / ask / mid.
import { fmtPrice } from "../../lib/format";
import { type LadderModel, ladderPos } from "../../lib/quote";
import { cx } from "../ui";

function Level(props: { at: number; label: string; price: number; className: string; lineClass?: string; side?: "left" | "right"; dim?: boolean }) {
  return (
    <div className={cx("absolute inset-x-0", props.dim && "opacity-45")} style={{ top: `${props.at * 100}%` }}>
      <div className={cx("absolute inset-x-0 -translate-y-1/2 border-t-2", props.lineClass ?? "border-ink")} />
      <div className={cx("absolute -translate-y-1/2 px-1 text-[10.5px] font-semibold tracking-[0.06em] uppercase", props.className, props.side === "left" ? "left-1" : "right-1")}>
        <span className="rounded-[2px] bg-surface px-1">
          {props.label} <span className="num font-medium tracking-normal">{fmtPrice(props.price)}</span>
        </span>
      </div>
    </div>
  );
}

export function QuoteLadder({ m, height = 232 }: { m: LadderModel; height?: number }) {
  const pos = (p: number) => ladderPos(m, p);
  const bandTop = pos(m.bandHigh);
  const bandBottom = pos(m.bandLow);
  const wTop = pos(m.mid + m.minWidthAbs / 2);
  const wBottom = pos(m.mid - m.minWidthAbs / 2);
  return (
    <div className="relative overflow-hidden rounded-[2px] border border-line bg-surface-2" style={{ height }} role="img" aria-label={`Quote ladder: bid ${fmtPrice(m.bid)}, ask ${fmtPrice(m.ask)}, oracle ${fmtPrice(m.oracle)}`}>
      {/* allowed mid band */}
      <div className="absolute inset-x-0 bg-good/10" style={{ top: `${bandTop * 100}%`, height: `${(bandBottom - bandTop) * 100}%` }} />
      <div className="absolute inset-x-0 border-t border-dashed border-good/70" style={{ top: `${bandTop * 100}%` }} />
      <div className="absolute inset-x-0 border-t border-dashed border-good/70" style={{ top: `${bandBottom * 100}%` }} />
      <div className="absolute left-1 text-[9.5px] font-semibold tracking-[0.06em] text-good-ink uppercase" style={{ top: `calc(${bandTop * 100}% + 2px)` }}>
        max skew band
      </div>
      {/* min width bracket around the mid */}
      <div
        className="absolute left-1/2 w-10 -translate-x-1/2 border-x-2 border-accent/60 bg-accent-soft"
        style={{ top: `${wTop * 100}%`, height: `${Math.max(0.5, (wBottom - wTop) * 100)}%` }}
        title="Minimum quote width at the current mid"
      />
      {/* oracle */}
      <div className="absolute inset-x-0" style={{ top: `${pos(m.oracle) * 100}%` }}>
        <div className="absolute inset-x-0 -translate-y-1/2 border-t border-dashed border-ink-2" />
      </div>
      <Level at={pos(m.ask)} label="Ask" price={m.ask} className="text-ink" side="right" dim={!m.sides.ask} />
      <Level at={pos(m.bid)} label="Bid" price={m.bid} className="text-ink" side="right" dim={!m.sides.bid} />
      <div className="absolute left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-accent ring-2 ring-surface" style={{ top: `${pos(m.mid) * 100}%` }} title={`Mid ${fmtPrice(m.mid)}`} />
      <div className="absolute left-1 -translate-y-1/2 text-[10.5px] font-semibold tracking-[0.06em] text-ink-2 uppercase" style={{ top: `${pos(m.oracle) * 100}%` }}>
        <span className="rounded-[2px] bg-surface-2 px-1">
          Oracle <span className="num font-medium tracking-normal">{fmtPrice(m.oracle)}</span>
        </span>
      </div>
    </div>
  );
}
