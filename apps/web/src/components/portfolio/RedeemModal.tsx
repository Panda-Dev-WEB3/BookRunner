// Request a redemption of Senior or Junior shares. The API prepares tranche.requestRedeem with the
// exact schedule (eligible time, the mark that settles it, an indicative value); the wallet signs it.
// Notice is not a gate: the request is always accepted.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { trpc } from "../../api/trpc";
import { USDC_DECIMALS, amountIssue, formatAmountInput, parseAmount } from "../../lib/amount";
import { COLLECT_LINE, NOTICE_LINE } from "../../lib/copy";
import { fmtDuration, fmtSharePrice, fmtWhen, isoToSec, usdRaw } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { TxRunner } from "../../wallet/TxRunner";
import { Term } from "../Term";
import { AmountInput, Callout, ErrorState, KV, Modal, TrancheBadge } from "../ui";
import { TRANCHE_NAME, shares, usd } from "./display";
import { refreshAfterTx } from "./hooks";
import { type TrancheHolding, sharesValue } from "./model";

export function RedeemModal(props: { open: boolean; onClose: () => void; bookId: number; ticker: string; holding: TrancheHolding | null; wallet: Address }) {
  const { open, bookId, wallet, holding } = props;
  const sym = useSettlementSymbol();
  const [amount, setAmount] = useState("");
  const red = trpc.tranche.redeem.useMutation();
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const book = trpc.book.get.useQuery({ bookId }, { enabled: open && holding?.tranche === "junior", staleTime: 60_000 });
  const { reset } = red;

  useEffect(() => {
    if (!open) {
      setAmount("");
      reset();
    }
  }, [open, reset]);

  if (!holding) return null;
  const name = TRANCHE_NAME[holding.tranche];
  const held = holding.shares ?? 0n;
  const issue = amountIssue(amount, { balance: held });
  const raw = parseAmount(amount, USDC_DECIMALS);
  const indicative = raw !== null && raw > 0n ? sharesValue(raw, holding.sharePriceWad) : null;
  const notice = book.data?.charter?.juniorNoticeSeconds ?? null;

  const prepare = () => {
    if (raw === null || issue) return;
    red.mutate({ bookId, tranche: holding.tranche, shares: formatAmountInput(raw, USDC_DECIMALS), wallet });
  };

  return (
    <Modal
      open={open}
      onClose={props.onClose}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Redeem from the {props.ticker} book <TrancheBadge tranche={holding.tranche} size="sm" />
        </span>
      }
      description={
        holding.tranche === "senior"
          ? `Senior requests settle at the next mark, at that mark's share price. There is no notice period. ${COLLECT_LINE}`
          : `Junior requests wait out the book's notice period${notice ? ` (${fmtDuration(notice)})` : ""}, then settle at the first mark after it, at that mark's share price. ${COLLECT_LINE}`
      }
      size="md"
    >
      <div className="space-y-4">
        <AmountInput
          id={`redeem-${bookId}-${holding.tranche}`}
          label={`${name} shares to redeem`}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            if (red.data || red.error) red.reset();
          }}
          symbol="shares"
          balance={held}
          balanceLabel="You hold"
          issue={issue === "exceeds-balance" ? null : issue}
          error={issue === "exceeds-balance" ? "This is more shares than the wallet holds." : null}
          help={
            indicative !== null ? (
              <>
                About <span className="num">{usd(indicative)}</span> at the latest share price ({fmtSharePrice(holding.sharePrice, 6)}). This is an estimate: the mark that settles the request sets the amount.
              </>
            ) : (
              "Shares leave your wallet when you send the request and wait in the tranche's escrow until a mark settles them."
            )
          }
        />
        {!red.data && (
          <button type="button" className="btn btn-primary w-full" disabled={!!issue || red.isPending} onClick={prepare}>
            {red.isPending ? "Preparing…" : "Review the redemption request"}
          </button>
        )}
        {red.error && <ErrorState compact error={red.error} />}
        {red.data && (
          <div className="space-y-3">
            <KV
              rows={[
                ["Shares", shares(usdRaw(red.data.shares))],
                ["Eligible from", fmtWhen(isoToSec(red.data.eligibleAt))],
                ["Settles at the mark ending", fmtWhen(isoToSec(red.data.settlesAtPeriodEnd))],
                ["Indicative value (estimate)", `${usd(usdRaw(red.data.indicative.valueUsd))} at ${fmtSharePrice(red.data.indicative.sharePrice, 6)}`],
              ]}
            />
            <TxRunner
              txs={red.data.txs}
              signer={red.data.signer}
              amount={raw}
              onConfirmed={() => {
                void refreshAfterTx(qc, utils);
              }}
            />
          </div>
        )}
        <Callout tone="info" compact title={<Term id="redemptionNotice">Redemption notice</Term>}>
          {NOTICE_LINE} Once settled, the {sym} shows here as ready to claim.
        </Callout>
      </div>
    </Modal>
  );
}
