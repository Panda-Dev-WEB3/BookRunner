// "Your stake": what the connected wallet holds, has staked, can unstake, has locked as bonds, has
// cooling down, and can claim. Read live from BkrnStaking (useStakePosition) every 15 s.
import { useNow } from "../../api/hooks";
import { fmtDuration, fmtWhen } from "../../lib/format";
import { cx } from "../cx";
import { Badge, Card, ErrorState, ProgressBar, Skeleton, Stat, Term } from "../ui";
import { WithUnit } from "./StakeOverview";
import { type StakePart, type StakePosition, bkrnNum, cooldownState, countdownLabel, fmtBkrn, fmtShare, formatCountdown, poolShare, stakeBreakdown } from "./stakeLogic";

const PART: Record<StakePart, { label: string; swatch: string; hint: string }> = {
  available: { label: "Free to unstake", swatch: "bg-bkrn", hint: "Not locked and not cooling down." },
  pending: { label: "Cooling down", swatch: "bg-bkrn/40", hint: "In an unstake request, waiting out the cooldown." },
  locked: { label: "Locked as bonds", swatch: "hatch bg-surface-3", hint: "Held for a sponsor, committee or agent role." },
};

function BreakdownBar({ p }: { p: StakePosition }) {
  const parts = stakeBreakdown(p);
  if (p.staked === 0n) return null;
  return (
    <div className="mt-5">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={parts.map((x) => `${PART[x.part].label} ${fmtShare(x.share)}`).join(", ")}>
        {parts
          .filter((x) => x.share > 0)
          .map((x) => (
            <div key={x.part} className={cx("h-full first:rounded-l-full last:rounded-r-full", PART[x.part].swatch)} style={{ width: `${Math.max(x.share * 100, 1.5)}%` }} title={`${PART[x.part].label}: ${fmtBkrn(x.amount)}`} />
          ))}
      </div>
      <ul className="mt-3 grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-3">
        {parts.map((x) => (
          <li key={x.part} className="flex min-w-0 items-start gap-2">
            <span className={cx("mt-1 size-2.5 shrink-0 rounded-[3px] border border-line-strong", PART[x.part].swatch)} aria-hidden />
            <span className="min-w-0">
              <span className="block font-medium text-ink">{PART[x.part].label}</span>
              <span className="num block text-ink-2">{fmtBkrn(x.amount)}</span>
              <span className="block text-[11.5px] text-muted">{PART[x.part].hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Live countdown for an open unstake request (re-renders every second only while mounted). */
export function CooldownStatus(props: { pending: bigint; availableAt: number; cooldownSec: number | null; className?: string }) {
  const now = useNow(1_000);
  const s = cooldownState(props.pending, props.availableAt, now / 1000, props.cooldownSec);
  if (s.kind === "none") return null;
  if (s.kind === "ready") {
    return (
      <div className={cx("rounded-control border border-good/30 bg-good/[0.07] p-3.5", props.className)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13.5px] font-semibold text-ink">{fmtBkrn(s.amount)} is ready to withdraw</span>
          <Badge tone="good" dot size="sm">
            Cooldown over
          </Badge>
        </div>
        <p className="mt-1 text-[12.5px] text-ink-2">The wait ended {fmtWhen(s.availableAt)}. Withdraw it from the Unstake tab, or cancel the request to keep it staked.</p>
      </div>
    );
  }
  return (
    <div className={cx("rounded-control border border-line bg-surface-2/70 p-3.5", props.className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13.5px] font-semibold text-ink">{fmtBkrn(s.amount)} cooling down</span>
        <span className="text-[12.5px] text-ink-2">
          Withdraw in{" "}
          <span role="timer" aria-label={countdownLabel(s.secondsLeft)} className="num font-semibold text-ink">
            {formatCountdown(s.secondsLeft)}
          </span>
        </span>
      </div>
      {s.progress !== null && <ProgressBar value={s.progress} label="Cooldown elapsed" tone="backstop" className="mt-2.5" />}
      <p className="mt-2 text-[12px] text-ink-2">
        Withdrawable from {fmtWhen(s.availableAt)}. It still counts as staked until then, but it no longer shares in buybacks.
      </p>
    </div>
  );
}

/** The connected wallet's stake (the page renders it only once a wallet is connected). */
export function StakePosition(props: {
  position: StakePosition | undefined;
  walletBkrn: bigint | null | undefined;
  totalStaked: bigint | null | undefined;
  cooldownSec: number | null;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const p = props.position;
  if (!p) {
    return (
      <Card title="Your stake">
        {props.error && !props.isLoading ? (
          <ErrorState compact error={props.error} onRetry={props.onRetry} />
        ) : (
          <div className="space-y-3" aria-busy="true" aria-label="Loading your stake">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        )}
      </Card>
    );
  }
  const share = poolShare(p.staked, props.totalStaked);
  return (
    <Card
      title="Your stake"
      description={
        <>
          Live from the <Term id="staking">staking</Term> contract, refreshed every 15 seconds.
        </>
      }
    >
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-3">
        <Stat
          size="lg"
          series="bkrn"
          label="Staked"
          title={fmtBkrn(p.staked, 6)}
          value={<WithUnit value={bkrnNum(p.staked)} unit="BKRN" />}
          sub={p.staked > 0n ? `${fmtShare(share)} of all staked BKRN` : "Nothing staked yet"}
        />
        <Stat
          size="lg"
          label="In your wallet"
          title={props.walletBkrn == null ? undefined : fmtBkrn(props.walletBkrn, 6)}
          value={<WithUnit value={props.walletBkrn === undefined ? "…" : bkrnNum(props.walletBkrn)} unit="BKRN" />}
          sub="Not staked, ready to stake"
        />
        <Stat
          size="lg"
          series="bkrn"
          label="Ready to claim"
          title={fmtBkrn(p.earned, 6)}
          value={<WithUnit value={bkrnNum(p.earned, 4)} unit="BKRN" />}
          sub={p.earned > 0n ? "Your share of past buybacks" : "Nothing to claim yet"}
        />
      </div>
      <BreakdownBar p={p} />
      {p.locked > 0n && (
        <p className="mt-4 text-[12.5px] text-ink-2">
          {fmtBkrn(p.locked)} is locked as a bond for a protocol role (a <Term id="sponsor">sponsor</Term>, <Term id="riskCommittee">Risk Committee</Term> or agent bond). The contract that locked it releases it when the role ends;
          until then it cannot be unstaked.
        </p>
      )}
      {p.pending > 0n && <CooldownStatus className="mt-4" pending={p.pending} availableAt={p.availableAt} cooldownSec={props.cooldownSec} />}
      {p.staked === 0n && p.pending === 0n && (
        <p className="mt-4 text-[12.5px] text-ink-2">
          You have no BKRN staked. Staking takes two wallet confirmations: one to allow the transfer, one to stake. Unstaking later takes {props.cooldownSec === null ? "a cooldown" : fmtDuration(props.cooldownSec)}.
        </p>
      )}
    </Card>
  );
}
