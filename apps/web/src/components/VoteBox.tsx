// Committee vote: charter.decide prepares RiskCommittee.vote for the connected member's wallet.
import { useState } from "react";
import { trpc } from "../api/trpc";
import { TxRunner } from "../wallet/TxRunner";
import { WalletButton } from "../wallet/WalletButton";
import { useWallet } from "../wallet/WalletContext";
import { ErrorState, cx } from "./ui";

export function TallyBar(props: { approvals: number; rejections: number; approveThreshold: number; rejectThreshold: number; juryPosted: boolean }) {
  const seats = 3;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1" aria-label={`${props.approvals} approvals, ${props.rejections} rejections of ${seats} seats`}>
        {Array.from({ length: seats }, (_, i) => {
          const kind = i < props.approvals ? "approve" : i >= seats - props.rejections ? "reject" : "open";
          return <span key={i} className={cx("h-2 flex-1 rounded-[1px]", kind === "approve" ? "bg-good" : kind === "reject" ? "bg-critical" : "bg-surface-3")} />;
        })}
      </div>
      <div className="num flex justify-between text-[11px] text-ink-2">
        <span>
          {props.approvals}/{props.approveThreshold} to approve
        </span>
        <span>
          {props.rejections}/{props.rejectThreshold} to reject
        </span>
      </div>
      {!props.juryPosted && <div className="text-[11px] text-muted">Approval finalises only after the jury verdict is posted on-chain.</div>}
    </div>
  );
}

export function VoteBox({ charterId, onVoted }: { charterId: number; onVoted?: () => void }) {
  const w = useWallet();
  const utils = trpc.useUtils();
  const decide = trpc.charter.decide.useMutation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const prepare = (approve: boolean) => {
    if (!w.active) return;
    setChoice(approve);
    decide.mutate({ charterId, member: w.active.address, approve });
  };
  const refresh = () => {
    void utils.charter.get.invalidate({ charterId });
    void utils.charter.list.invalidate();
    onVoted?.();
  };
  if (!w.active) return <WalletButton label="Connect a committee wallet to vote" />;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx("btn", choice === true && decide.data ? "btn-primary" : "")} disabled={decide.isPending} onClick={() => prepare(true)}>
          Vote approve
        </button>
        <button type="button" className={cx("btn btn-danger", choice === false && decide.data && "bg-critical/10")} disabled={decide.isPending} onClick={() => prepare(false)}>
          Vote reject
        </button>
      </div>
      {decide.error && <ErrorState compact error={decide.error} />}
      {decide.data && (
        <div className="space-y-2">
          {decide.data.warnings.map((x) => (
            <div key={x} className="text-[11.5px] text-warn-ink">
              {x}
            </div>
          ))}
          <div className="text-[11.5px] text-ink-2">
            After this vote: {decide.data.projected.approvals} approval(s), {decide.data.projected.rejections} rejection(s) · outcome {decide.data.projected.outcome}
          </div>
          <TxRunner txs={decide.data.txs} signer={decide.data.signer} signerHint="committee member" onConfirmed={refresh} />
        </div>
      )}
    </div>
  );
}
