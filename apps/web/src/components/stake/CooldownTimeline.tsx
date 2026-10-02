// The three steps out of staking (request -> wait -> withdraw), with the live cooldown length.
// Vertical on phones, horizontal from md. Follows BkrnStaking.requestUnstake / cancelUnstake / unstake.
import type { ReactNode } from "react";
import { fmtDuration } from "../../lib/format";
import { cx } from "../cx";
import { IconCheck } from "../icons";

function Clock({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 6v4.2l2.6 1.6" />
    </svg>
  );
}

interface Step {
  marker: ReactNode;
  markerClass: string;
  line?: "solid" | "dashed";
  title: string;
  body: ReactNode;
}

export function CooldownTimeline({ cooldownSec }: { cooldownSec: number | null }) {
  const wait = cooldownSec === null ? "the cooldown" : fmtDuration(cooldownSec);
  const steps: Step[] = [
    {
      marker: "1",
      markerClass: "border-bkrn bg-bkrn text-white",
      line: "solid",
      title: "Request",
      body: "Choose an amount of free stake and send an unstake request. You can cancel it at any time before you withdraw.",
    },
    {
      marker: <Clock />,
      markerClass: "border-bkrn bg-surface text-bkrn-ink ring-4 ring-bkrn/15",
      line: "dashed",
      title: `Wait ${wait}`,
      body: "The BKRN stays staked, so it keeps its share of any buyback. It cannot be locked as a bond meanwhile. A second request adds to the first and restarts the wait for all of it.",
    },
    {
      marker: <IconCheck size={14} strokeWidth={2.4} />,
      markerClass: "border-good bg-good text-surface",
      title: "Withdraw",
      body: "Once the wait is over, one more transaction sends the whole requested amount back to your wallet. Nothing is sent on its own: you choose when.",
    },
  ];
  return (
    <ol className="grid gap-6 md:grid-cols-3 md:gap-6" aria-label="How unstaking works">
      {steps.map((s, i) => (
        <li key={s.title} className="relative pl-11 md:pl-0 md:pt-11">
          <span className={cx("absolute top-0 left-0 inline-flex size-7 items-center justify-center rounded-full border text-[12px] font-semibold tnum", s.markerClass)} aria-hidden>
            {s.marker}
          </span>
          {s.line && (
            <span
              className={cx(
                "absolute top-9 -bottom-5 left-[13px] w-0 border-l-2 md:top-[13px] md:right-[-12px] md:bottom-auto md:left-10 md:h-0 md:w-auto md:border-t-2 md:border-l-0",
                s.line === "dashed" ? "border-dashed border-bkrn/50" : "border-bkrn/60",
              )}
              aria-hidden
            />
          )}
          <h3 className="text-[15px] font-semibold text-ink">
            <span className="sr-only">{`Step ${i + 1}: `}</span>
            {s.title}
          </h3>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
        </li>
      ))}
    </ol>
  );
}
