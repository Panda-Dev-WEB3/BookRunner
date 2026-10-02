// Small shared pieces of the invest flow: the deposit-window badge and sentence, the risk notice,
// the step trail (1 tranche · 2 amount · 3 review) and the tranche swatch.
import type { ReactNode } from "react";
import { config } from "../../lib/config";
import { fmtDuration } from "../../lib/format";
import { isTestChain } from "../../wallet/network";
import { IconCheck } from "../icons";
import { Badge, Callout, Term, cx } from "../ui";
import { type DepositWindow, type TrancheId, fmtDay, fmtWhen } from "./logic";

/** Short status pill for a book's deposit window. */
export function WindowBadge({ w, nowSec, size }: { w: DepositWindow; nowSec: number; size?: "sm" | "md" }) {
  switch (w.status) {
    case "loading":
      return (
        <Badge size={size} tone="neutral">
          Checking deposits…
        </Badge>
      );
    case "open":
      return (
        <Badge size={size} tone="good" dot title={`Open until ${fmtWhen(w.endsAt)}`}>
          {w.kind === "subscription" ? "Subscription open" : "Deposits open"} · {w.endsAt - nowSec > 86_400 * 2 ? `until ${fmtDay(w.endsAt)}` : `${fmtDuration(w.endsAt - nowSec)} left`}
        </Badge>
      );
    case "settling":
      return (
        <Badge size={size} tone="warn" dot>
          Round ended · settling
        </Badge>
      );
    case "paused":
      return (
        <Badge size={size} tone="warn" dot>
          Deposits paused
        </Badge>
      );
    case "closed":
      return (
        <Badge size={size} tone="neutral" dot>
          Deposits closed
        </Badge>
      );
  }
}

/** One or two sentences on what the deposit window means right now. */
export function windowSentence(w: DepositWindow): string {
  switch (w.status) {
    case "loading":
      return "Checking whether this book takes deposits right now…";
    case "open":
      return w.kind === "subscription"
        ? `The subscription window is open until ${fmtWhen(w.endsAt)}. When it closes, commitments are allocated pro-rata and shares start at 1.00 USDC each.`
        : `A top-up round is open until ${fmtWhen(w.endsAt)}. Deposits wait in escrow and are turned into shares at the first mark after the round ends (${fmtWhen(w.settlesAt)}), at that mark's share price.`;
    case "settling":
      return w.kind === "subscription"
        ? `The subscription window closed at ${fmtWhen(w.endsAt)}. Commitments are allocated as soon as the window is closed on-chain.`
        : `The round ended at ${fmtWhen(w.endsAt)}. It settles at the first mark after that (${fmtWhen(w.settlesAt)}); then you can collect your shares and any refund.`;
    case "paused":
      return w.by === "guardian"
        ? "The protocol guardian has paused new deposits for now. Withdrawals and claims are never blocked by a pause."
        : "The sponsor or guardian has paused deposits into this tranche. Withdrawals and claims are never blocked by a pause.";
    case "closed":
      switch (w.why) {
        case "no-round":
          return "This book takes deposits only during a top-up round, which its sponsor opens with a capacity per tranche. No round is open right now. You can still withdraw and claim at any time.";
        case "cancelled":
          return "This book was cancelled at the end of its subscription window. Every commitment can be taken back 1:1 from the Withdraw tab.";
        case "retiring":
          return "This book is winding down, so it takes no new deposits. Withdrawals keep settling at each mark.";
        case "retired":
          return "This book is retired. Withdrawals settle at its final price.";
        default:
          return "This book does not take deposits right now.";
      }
  }
}

/** The short testnet and risk notice shown wherever money is involved. */
export function RiskNotice({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <Callout tone="risk" compact={compact} className={className} title={isTestChain ? "Test network: practise, nothing real at stake" : "Your capital is at risk"}>
      {isTestChain ? (
        <>
          This is <Term id="testnet">{config.chain.name}</Term>. Test USDC has no value. On a live network, a deposit can lose value: <Term id="junior">Junior</Term> absorbs losses first and{" "}
          <Term id="senior">Senior</Term> is last loss, not no loss. Past fee flow says nothing about the next period. Nothing here is an offer or advice.
        </>
      ) : (
        <>
          A deposit can lose value. <Term id="junior">Junior</Term> absorbs losses first and <Term id="senior">Senior</Term> is last loss, not no loss. Past fee flow says nothing about the next
          period. Nothing here is an offer or advice.
        </>
      )}
    </Callout>
  );
}

export type FlowStep = "tranche" | "amount" | "review";
const STEPS: Array<{ id: FlowStep; label: string }> = [
  { id: "tranche", label: "Choose a tranche" },
  { id: "amount", label: "Amount" },
  { id: "review", label: "Review and sign" },
];

/** Horizontal step trail for the deposit flow. Completed steps can be revisited. */
export function StepTrail(props: { step: FlowStep; done?: boolean; onGo?: (s: FlowStep) => void; className?: string }) {
  const at = STEPS.findIndex((s) => s.id === props.step);
  return (
    <ol className={cx("flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]", props.className)} aria-label="Deposit steps">
      {STEPS.map((s, i) => {
        const state = props.done || i < at ? "done" : i === at ? "active" : "todo";
        const dot = (
          <span
            className={cx(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11.5px] font-semibold tnum",
              state === "done" && "border-good bg-good text-surface",
              state === "active" && "border-accent bg-surface text-accent-text ring-4 ring-accent-soft",
              state === "todo" && "border-line-strong bg-surface text-muted",
            )}
            aria-hidden
          >
            {state === "done" ? <IconCheck size={13} strokeWidth={2.4} /> : i + 1}
          </span>
        );
        // On phones only the current step keeps its label on screen (the others stay for screen readers).
        const label = <span className={cx("font-medium", state === "todo" ? "text-ink-2" : "text-ink", state !== "active" && "sr-only sm:not-sr-only")}>{s.label}</span>;
        const sr = <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (current step)" : ""}</span>;
        return (
          <li key={s.id} className="flex items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
            {i > 0 && <span className={cx("h-px w-4 sm:w-8", i <= at || props.done ? "bg-good/60" : "bg-line-strong")} aria-hidden />}
            {state === "done" && props.onGo && !props.done ? (
              <button type="button" className="inline-flex items-center gap-2 rounded-control hover:underline" onClick={() => props.onGo?.(s.id)}>
                {dot}
                {label}
                {sr}
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                {dot}
                {label}
                {sr}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Colour swatch + name for a tranche (fixed colour coding: Senior blue, Junior amber). */
export function TrancheSwatch({ t, className }: { t: TrancheId; className?: string }) {
  return <span className={cx("inline-block size-2.5 shrink-0 rounded-[3px]", t === "senior" ? "bg-senior" : "bg-junior", className)} aria-hidden />;
}

/** Label / value list that wraps instead of truncating, so it reads at phone width. */
export function InfoList(props: { rows: Array<[ReactNode, ReactNode] | null | false | undefined | "" | 0>; className?: string }) {
  return (
    <dl className={cx("divide-y divide-line text-[13px]", props.className)}>
      {props.rows
        .filter((r): r is [ReactNode, ReactNode] => Array.isArray(r))
        .map(([k, v], i) => (
          <div key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
            <dt className="min-w-0 text-ink-2">{k}</dt>
            <dd className="num ml-auto min-w-0 text-right text-ink">{v}</dd>
          </div>
        ))}
    </dl>
  );
}
