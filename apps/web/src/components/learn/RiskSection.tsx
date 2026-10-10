// 6. Risk controls: the mandate's limits (with the showcase book's live values), a quote checker that runs
// the shared mandate check, and a short "when something goes wrong" timeline from testnet.
import { type ReactNode, useId, useState } from "react";
import { fmtUsd, tickerOf } from "../../lib/format";
import { getSettlementSymbol } from "../../lib/settlementToken";
import { cx } from "../cx";
import { Term } from "../Term";
import { Badge, Card } from "../ui";
import { Figure, LearnSection } from "./parts";
import { type QuoteLimits, pctText, quoteDemo } from "./sim";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { useShowcaseBook } from "./useLearnData";

/** The NVDA launch book's quote limits (ARCHITECTURE.md §7), shown until the live mandate loads. */
const DOC_LIMITS: QuoteLimits = { minQuoteWidthBps: 8, maxSkewBps: 25 };
const ORACLE_PX = 100;

interface Limit {
  id: string;
  name: ReactNode;
  what: string;
  enforced: string;
  live: (m: MandateLike) => string;
}

interface MandateLike {
  maxInventoryUsd: string;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: number;
}

const LIMITS: Limit[] = [
  {
    id: "width",
    name: "Minimum quote width",
    what: "The gap between the agent's buy and sell price can never be narrower than this, so it cannot quote recklessly tight.",
    enforced: "Checked by the agent before every quote and by the engine on in-house books; watched by the risk service.",
    live: (m) => `${m.minQuoteWidthBps} bps`,
  },
  {
    id: "skew",
    name: "Maximum skew",
    what: "How far the middle of the quotes may sit from the oracle price. It stops the agent leaning hard to one side.",
    enforced: "Checked before every quote and watched by the risk service.",
    live: (m) => `${m.maxSkewBps} bps`,
  },
  {
    id: "inventory",
    name: "Maximum inventory",
    what: "The largest net position the book may hold on the venue, long or short.",
    enforced: "A hard cap on the in-house engine; monitored with venue position caps on Orderly.",
    live: (m) => `${fmtUsd(m.maxInventoryUsd, { compact: true })} ${getSettlementSymbol()}`,
  },
  {
    id: "band",
    name: <Term id="hedgeBand">Hedge band</Term>,
    what: "Hedges in Stock Tokens must offset a set share of the book's net exposure. Every hedge trade has to stay in the band or move closer to it.",
    enforced: "Checked in code by the mandate contract on every hedge leg.",
    live: (m) => `${pctText(m.hedgeRatioMinBps)} to ${pctText(m.hedgeRatioMaxBps)}`,
  },
  {
    id: "offhours",
    name: "Off-hours: reduce only",
    what: "When the stock market is closed and the price feed holds, the agent may only reduce risk. Quoting against a frozen price invites traders who know more.",
    enforced: "Enforced on-chain by the in-house engine, and by the mandate contract for hedges and inventory moves. On Orderly books, venue quoting follows it and is monitored by the risk service.",
    live: (m) => (m.noNewRiskOffHours ? "On" : "Off"),
  },
  {
    id: "kill",
    name: <Term id="killSwitch">Drawdown kill</Term>,
    what: "If the book falls this far below its high-water mark, the mandate is killed: quoting stops and agent keys are revoked.",
    enforced: "Checked on-chain at every mark, and between marks by the risk service.",
    live: (m) => pctText(m.killAtDrawdownBps),
  },
];

const INCIDENT = [
  {
    title: "Exposure drifted",
    body: "The book's net position on the venue grew faster than its hedge. The hedge ratio left the band and stayed out past the grace period.",
  },
  {
    title: "Risk killed the book",
    body: "The risk service cancelled quotes and killed the mandate, which revoked the agent's keys. Redemptions kept working the whole time.",
  },
  {
    title: "The committee re-mandated",
    body: "Two of the three committee members approved a re-mandate on the same terms, and the sponsor registered a fresh agent key.",
  },
  {
    title: "The agent re-hedged",
    body: "Now planning hedges from the latest signed venue report, the agent rebuilt the hedge inside the band and went back to quoting.",
  },
];

/** Price ladder: the oracle in the middle, the allowed skew zone around it, the bid and the ask. */
function QuoteLadder(props: { width: number; skew: number; limits: QuoteLimits }) {
  const d = quoteDemo(ORACLE_PX, props.width, props.skew, props.limits);
  const range = 70; // bps shown either side of the oracle
  const x = (px: number) => 180 + ((px / ORACLE_PX - 1) * 10_000 * 160) / range;
  const zoneL = x(ORACLE_PX * (1 - props.limits.maxSkewBps / 10_000));
  const zoneR = x(ORACLE_PX * (1 + props.limits.maxSkewBps / 10_000));
  const clampX = (v: number) => Math.min(352, Math.max(8, v));
  const bad = "var(--critical)";
  return (
    <svg viewBox="0 0 360 132" className="block h-auto w-full" role="img" aria-label={`Bid ${d.bid.toFixed(3)}, ask ${d.ask.toFixed(3)}, oracle ${ORACLE_PX.toFixed(2)}. ${d.ok ? "The quote passes the mandate." : "The quote breaks the mandate."}`}>
      <rect x={zoneL} y="30" width={Math.max(0, zoneR - zoneL)} height="56" rx="6" fill="var(--accent)" fillOpacity="0.1" stroke="var(--accent)" strokeOpacity="0.35" strokeDasharray="4 3" />
      <text x={(zoneL + zoneR) / 2} y="22" textAnchor="middle" fontSize="11" fill="var(--accent-text)">
        mid may sit here (max skew)
      </text>
      <line x1="8" y1="58" x2="352" y2="58" stroke="var(--line-strong)" strokeWidth="1.5" />
      <line x1="180" y1="30" x2="180" y2="86" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="3 3" />
      <text x="180" y="104" textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--ink-2)">
        Oracle {ORACLE_PX.toFixed(2)}
      </text>
      {/* spread between bid and ask */}
      <rect x={clampX(x(d.bid))} y="50" width={Math.max(1.5, clampX(x(d.ask)) - clampX(x(d.bid)))} height="16" rx="3" fill={d.widthOk ? "var(--ink)" : bad} fillOpacity="0.14" />
      <circle cx={clampX(x(d.mid))} cy="58" r="3.5" fill={d.skewOk ? "var(--ink)" : bad} />
      <line x1={clampX(x(d.bid))} y1="42" x2={clampX(x(d.bid))} y2="74" stroke={d.widthOk ? "var(--ink)" : bad} strokeWidth="2.5" strokeLinecap="round" />
      <line x1={clampX(x(d.ask))} y1="42" x2={clampX(x(d.ask))} y2="74" stroke={d.widthOk ? "var(--ink)" : bad} strokeWidth="2.5" strokeLinecap="round" />
      <text x={clampX(x(d.bid)) - 4} y="124" textAnchor="end" fontSize="11.5" fill="var(--ink)">
        Bid {d.bid.toFixed(3)}
      </text>
      <text x={clampX(x(d.ask)) + 4} y="124" textAnchor="start" fontSize="11.5" fill="var(--ink)">
        Ask {d.ask.toFixed(3)}
      </text>
    </svg>
  );
}

function QuoteChecker(props: { limits: QuoteLimits; source: ReactNode }) {
  const id = useId();
  const [width, setWidth] = useState(12);
  const [skew, setSkew] = useState(5);
  const d = quoteDemo(ORACLE_PX, width, skew, props.limits);
  return (
    <Card title="Try the quote check" description="Move the quote and see whether the mandate lets it through." actions={props.source}>
      <QuoteLadder width={width} skew={skew} limits={props.limits} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="flex items-center justify-between text-[13px]">
            <label htmlFor={`${id}-w`} className="font-medium text-ink">
              Quote width
            </label>
            <output htmlFor={`${id}-w`} className="num font-medium">
              {width} bps
            </output>
          </div>
          <input
            id={`${id}-w`}
            type="range"
            min={0}
            max={40}
            step={1}
            value={width}
            aria-valuetext={`${width} basis points`}
            onChange={(e) => setWidth(Number(e.currentTarget.value))}
            className="mt-2 h-2 w-full cursor-pointer accent-[var(--accent)]"
          />
          <div className="mt-1 text-[12px] text-muted">Minimum {props.limits.minQuoteWidthBps} bps</div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[13px]">
            <label htmlFor={`${id}-s`} className="font-medium text-ink">
              Skew from the oracle
            </label>
            <output htmlFor={`${id}-s`} className="num font-medium">
              {skew > 0 ? "+" : ""}
              {skew} bps
            </output>
          </div>
          <input
            id={`${id}-s`}
            type="range"
            min={-50}
            max={50}
            step={1}
            value={skew}
            aria-valuetext={`${skew} basis points`}
            onChange={(e) => setSkew(Number(e.currentTarget.value))}
            className="mt-2 h-2 w-full cursor-pointer accent-[var(--accent)]"
          />
          <div className="mt-1 text-[12px] text-muted">At most {props.limits.maxSkewBps} bps either way</div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge tone={d.widthOk ? "good" : "critical"} dot>
          {d.widthOk ? "Width within limit" : "Too narrow"}
        </Badge>
        <Badge tone={d.skewOk ? "good" : "critical"} dot>
          {d.skewOk ? "Skew within limit" : "Too far from the oracle"}
        </Badge>
        <span className="text-[13px] font-medium text-ink">{d.ok ? "The mandate lets this quote through." : "The mandate rejects this quote."}</span>
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Prices are illustrative around an oracle price of {ORACLE_PX.toFixed(2)}; 100 bps = 1%. The check is the protocol's own mandate code.
      </p>
    </Card>
  );
}

export function RiskSection(props: { index: number }) {
  const { book, detail } = useShowcaseBook();
  useSettlementSymbol(); // the live inventory cap is shown in the settlement token's symbol
  const m = detail.data?.mandate ?? null;
  const ticker = book ? tickerOf(book.symbol) : null;
  const limits: QuoteLimits = m ? { minQuoteWidthBps: m.minQuoteWidthBps, maxSkewBps: m.maxSkewBps } : DOC_LIMITS;
  const source = <span className="text-[11.5px] text-muted">{m && ticker ? `Limits of the ${ticker} book, read on-chain` : "Testnet NVDA launch terms"}</span>;
  return (
    <LearnSection
      id="risk"
      index={props.index}
      eyebrow="Risk controls"
      title="An agent that cannot exceed its mandate"
      lead={
        <>
          The <Term id="bookrunnerAgent">bookrunner agent</Term> quotes and hedges the book, but only inside its <Term id="mandate">mandate</Term>: limits
          written into the charter and enforced by code and monitoring, not by trust.
        </>
      }
    >
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LIMITS.map((l) => (
          <li key={l.id} className="flex min-w-0 flex-col rounded-card border border-line bg-surface p-4 shadow-card">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[14.5px] font-semibold text-ink">{l.name}</h3>
              <span className={cx("num shrink-0 rounded-chip px-2 py-0.5 text-[12px] font-medium", m ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted")}>
                {m ? l.live(m) : "—"}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{l.what}</p>
            <p className="mt-auto pt-3 text-[12px] leading-snug text-muted">{l.enforced}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-muted">
        {m && ticker ? `Values shown are the live mandate of the ${ticker} book on this network.` : "Values appear once the API answers."} After a kill, the Risk
        Committee can re-mandate the book 2-of-3, on the same or new terms, and agent keys must be registered again.
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <QuoteChecker limits={limits} source={source} />
        <Figure label="What happens when something goes wrong" caption="A real sequence from one testnet book, told without the numbers. Redemptions stayed open at every step.">
          <h3 className="text-[15.5px] font-semibold text-ink">When something goes wrong</h3>
          <ol className="relative mt-4">
            <span className="absolute top-2 bottom-2 left-[11px] w-px bg-line-strong" aria-hidden />
            {INCIDENT.map((s, i) => (
              <li key={s.title} className="relative flex gap-3.5 pb-5 last:pb-0">
                <span
                  className={cx(
                    "tnum relative z-[1] inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11.5px] font-semibold",
                    i === 0 && "border-warn bg-surface text-warn-ink",
                    i === 1 && "border-critical bg-surface text-critical-ink",
                    i >= 2 && "border-good bg-surface text-good-ink",
                  )}
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-ink">{s.title}</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 rounded-control border border-good/30 bg-good/[0.07] p-3 text-[13px] text-ink-2">
            <span className="font-semibold text-ink">What it shows:</span> the limits held and the book stopped adding risk on its own. Restarting took an
            explicit 2-of-3 committee decision. The book paused; redemptions never did.
          </div>
        </Figure>
      </div>
    </LearnSection>
  );
}
