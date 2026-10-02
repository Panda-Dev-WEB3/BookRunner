// Step 1 of the deposit flow: Senior and Junior side by side, with this book's real charter terms
// (share of fee flow, Senior cap, withdrawal notice, fees), today's marked share price, the room
// left in the round and a one-line risk statement each.
import type { ReactNode } from "react";
import type { BookDetail } from "../../lib/api-types";
import { SPLIT_LINE, SPONSOR_SKIN_SHORT } from "../../lib/copy";
import { fmtDuration, fmtSharePrice } from "../../lib/format";
import { cadenceTitle } from "../../lib/lowgas";
import { IconCheck } from "../icons";
import { ProgressBar, Term, cx } from "../ui";
import { TrancheSwatch } from "./InvestBits";
import { roomFigure, roomNote } from "./investCopy";
import { type DepositWindow, TRANCHE_IDS, type TrancheId, type TrancheRoom, distributionShares, pctOfBps } from "./logic";
import type { ProtocolParams } from "./useInvestChain";

export const TRANCHE_LINE: Record<TrancheId, string> = {
  senior: "A fixed share of each distribution after expenses and carry. Junior absorbs losses before Senior does.",
  junior: "Takes losses first, and keeps the rest of each distribution plus any trading gains at the marks.",
};

export const TRANCHE_RISK: Record<TrancheId, string> = {
  senior: "Last loss, not no loss: Senior loses money if losses use up all of Junior and the backstop pool.",
  junior: "First loss: one bad period can take part or all of a Junior deposit.",
};

function Row(props: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-line py-2.5 first:border-t-0">
      <dt className="text-[12px] font-medium text-ink-2">{props.label}</dt>
      <dd className="mt-0.5 min-w-0 text-[13.5px] text-ink">{props.children}</dd>
    </div>
  );
}

export interface TrancheChoiceProps {
  book: BookDetail;
  params: ProtocolParams | undefined;
  /** Deposit window per tranche (paused flags differ per tranche). */
  windows: Record<TrancheId, DepositWindow>;
  /** Top-up room per tranche, Senior with the Senior cap applied (null: not a top-up round or unknown). */
  rooms: Record<TrancheId, TrancheRoom | null>;
  selected: TrancheId | null;
  onSelect: (t: TrancheId) => void;
}

export function TrancheChoice(props: TrancheChoiceProps) {
  const c = props.book.charter;
  const split = c ? distributionShares(c.seniorHurdleBps) : null;
  const cadence = cadenceTitle(props.book.markSchedule.cadence).toLowerCase();
  const notice = c ? fmtDuration(c.juniorNoticeSeconds) : null;

  const terms: Record<TrancheId, Array<[ReactNode, ReactNode]>> = {
    senior: [
      [
        <Term key="t" id="hurdle">
          Share of fee flow
        </Term>,
        split ? `${pctOfBps(split.senior)} of each distribution after expenses and carry` : "Set in the charter",
      ],
      ["Loss order", "Second: only after all of Junior is used up. The backstop may then cover Senior, up to what its pool holds."],
      ["Size limit", c ? `At most ${pctOfBps(c.seniorCapBps)} of the book when deposits are accepted (the Senior cap)` : "Set in the charter"],
      [
        <Term key="t" id="redemptionNotice">
          Withdrawals
        </Term>,
        `No notice period: settles at the next mark (${cadence}), then you collect the USDC`,
      ],
      [
        <Term key="t" id="sharePrice">
          Share price
        </Term>,
        <span key="v" className="num">
          {fmtSharePrice(props.book.seniorSharePrice, 6)} USDC <span className="text-muted">at the last mark</span>
        </span>,
      ],
    ],
    junior: [
      [
        <Term key="t" id="hurdle">
          Share of fee flow
        </Term>,
        split ? `${pctOfBps(split.junior)} of each distribution, plus any trading gains at the marks` : "Set in the charter",
      ],
      ["Loss order", "First: Junior absorbs losses before anyone else."],
      ["Size limit", c ? `At least ${pctOfBps(10_000 - c.seniorCapBps)} of the book when deposits are accepted. The sponsor ${SPONSOR_SKIN_SHORT}; later top-ups can dilute that share.` : "Set in the charter"],
      [
        <Term key="t" id="redemptionNotice">
          Withdrawals
        </Term>,
        notice && notice !== "none" ? `${notice} notice, then settles at the next mark (${cadence}); you then collect the USDC` : `Settles at the next mark (${cadence}); you then collect the USDC`,
      ],
      [
        <Term key="t" id="sharePrice">
          Share price
        </Term>,
        <span key="v" className="num">
          {fmtSharePrice(props.book.juniorSharePrice, 6)} USDC <span className="text-muted">at the last mark</span>
        </span>,
      ],
    ],
  };

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2" role="group" aria-label="Choose a tranche">
        {TRANCHE_IDS.map((t) => {
          const on = props.selected === t;
          const room = props.rooms[t];
          const win = props.windows[t];
          const name = t === "senior" ? "Senior" : "Junior";
          return (
            <div
              key={t}
              className={cx(
                "relative flex min-w-0 flex-col rounded-card border bg-surface p-4 transition-[border-color,box-shadow] duration-200 sm:p-5",
                on ? (t === "senior" ? "border-senior shadow-raised ring-2 ring-senior/40" : "border-junior shadow-raised ring-2 ring-junior/40") : "border-line hover:border-line-strong",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <TrancheSwatch t={t} className="size-3" />
                    <h3 className="text-[17px] font-semibold tracking-[-0.01em]">
                      <Term id={t}>{name}</Term>
                    </h3>
                    {t === "senior" ? (
                      <span className="rounded-full bg-senior/12 px-2 py-0.5 text-[11.5px] font-medium text-senior-ink">Last loss</span>
                    ) : (
                      <span className="rounded-full bg-junior/14 px-2 py-0.5 text-[11.5px] font-medium text-junior-ink">First loss · residual</span>
                    )}
                  </div>
                  <p className="mt-2 text-[13.5px] text-ink-2">{TRANCHE_LINE[t]}</p>
                </div>
              </div>

              <dl className="mt-3">
                {terms[t].map(([k, v], i) => (
                  <Row key={i} label={k}>
                    {v}
                  </Row>
                ))}
                <Row label={<Term id="topUpRound">Room this round</Term>}>
                  {win.status === "open" && room ? (
                    <div className="min-w-0">
                      <div className="num">{roomFigure(room)}</div>
                      <ProgressBar className="mt-1.5" value={room.filled} tone={t} label={`${name} capacity committed`} />
                      {roomNote(room, c?.seniorCapBps) && (
                        <div className={cx("mt-1 text-[12px]", room.oversubscribed ? "text-warn-ink" : "text-ink-2")}>{roomNote(room, c?.seniorCapBps)}</div>
                      )}
                    </div>
                  ) : win.status === "open" ? (
                    win.kind === "subscription" ? (
                      "Allocated pro-rata when the window closes"
                    ) : (
                      "Checking…"
                    )
                  ) : win.status === "paused" ? (
                    <span className="text-warn-ink">Deposits paused</span>
                  ) : win.status === "loading" ? (
                    "Checking…"
                  ) : (
                    <span className="text-ink-2">No open round</span>
                  )}
                </Row>
              </dl>

              <p className={cx("mt-3 rounded-control px-3 py-2 text-[12.5px]", t === "senior" ? "bg-senior/8 text-ink" : "bg-junior/10 text-ink")}>
                <span className="font-semibold">Risk: </span>
                {TRANCHE_RISK[t]}
              </p>

              <div className="mt-4 flex-1" />
              <button
                type="button"
                aria-pressed={on}
                onClick={() => props.onSelect(t)}
                className={cx("btn w-full", on ? "btn-primary" : "btn-secondary")}
              >
                {on ? (
                  <>
                    <IconCheck size={15} strokeWidth={2.2} /> {name} selected
                  </>
                ) : (
                  `Choose ${name}`
                )}
              </button>
            </div>
          );
        })}
      </div>

      <FeesNote params={props.params} />
    </div>
  );
}

/** Fees that apply to every book (from BookrunnerConfig), in plain words. */
export function FeesNote({ params, className }: { params: ProtocolParams | undefined; className?: string }) {
  const carry = params?.carryBps ?? null;
  const expense = params?.expenseCapBps ?? null;
  return (
    <div className={cx("mt-4 rounded-card border border-line bg-surface-2/60 px-4 py-3 text-[13px] text-ink-2", className)}>
      <span className="font-semibold text-ink">Fees. </span>
      No fee to deposit or withdraw (you only pay network gas), and no management fee. Before the <Term id="feeFlow">fee flow</Term> is shared, expenses (oracle and keeper gas
      {expense !== null ? `, capped at ${pctOfBps(expense)} of it` : ", capped on-chain"}) come off, then the protocol takes a{" "}
      <Term id="carry">{carry !== null ? `${pctOfBps(carry)} carry` : "carry"}</Term>. Along the <Term id="waterfall">waterfall</Term>, {SPLIT_LINE}
    </div>
  );
}
