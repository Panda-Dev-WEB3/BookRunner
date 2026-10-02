// Claim everything one book owes the wallet: settled allocations (shares plus any refund), USDC from
// settled redemptions and refunds of a cancelled window. The API prepares the claim transactions
// (tranche.claim); the wallet signs them in order through TxRunner.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Address } from "viem";
import { trpc } from "../../api/trpc";
import { CASH_WAIT_LINE } from "../../lib/copy";
import { usdRaw } from "../../lib/format";
import { TxRunner } from "../../wallet/TxRunner";
import { Callout, ErrorState, KV, Modal, SkeletonRows } from "../ui";
import { TRANCHE_NAME, shares, usd } from "./display";
import { refreshAfterTx } from "./hooks";

export function ClaimModal(props: { open: boolean; onClose: () => void; bookId: number | null; ticker: string; wallet: Address }) {
  const claim = trpc.tranche.claim.useMutation();
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const { bookId, open, wallet } = props;
  const { mutate, reset } = claim;

  // Preparing a claim only reads chain state: start as soon as the dialog opens.
  useEffect(() => {
    if (open && bookId !== null) mutate({ bookId, wallet });
    if (!open) reset();
  }, [open, bookId, wallet, mutate, reset]);

  const rows = (claim.data?.claimable ?? []).flatMap((c) => {
    const name = TRANCHE_NAME[c.tranche];
    const out: Array<[string, string]> = [];
    const cancelled = usdRaw(c.cancelledRefundUsd) ?? 0n;
    const allocShares = usdRaw(c.allocationShares) ?? 0n;
    const refund = usdRaw(c.refundUsd) ?? 0n;
    const redeemed = usdRaw(c.redemptionUsd) ?? 0n;
    if (cancelled > 0n) out.push([`${name}: refund of a cancelled round`, usd(cancelled)]);
    if (allocShares > 0n) out.push([`${name}: allocated shares`, shares(allocShares)]);
    if (refund > 0n) out.push([`${name}: refund of the part not accepted`, usd(refund)]);
    if (redeemed > 0n) out.push([`${name}: USDC from settled redemptions`, usd(redeemed)]);
    return out;
  });

  return (
    <Modal
      open={open}
      onClose={props.onClose}
      title={`Claim from the ${props.ticker} book`}
      description="Claiming sends what this book owes you to your wallet. Each claim is one transaction you approve in your wallet."
      size="md"
    >
      {claim.isPending || (!claim.data && !claim.error) ? (
        <SkeletonRows rows={3} />
      ) : claim.error ? (
        <ErrorState error={claim.error} onRetry={() => bookId !== null && mutate({ bookId, wallet })} />
      ) : claim.data ? (
        <div className="space-y-4">
          {claim.data.warnings.length > 0 && (
            <Callout tone="warn" compact title="Waiting for cash">
              <ul className="list-disc space-y-1 pl-4">
                {claim.data.warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Callout>
          )}
          {rows.length > 0 ? (
            <KV rows={rows} />
          ) : (
            <Callout tone="neutral" compact>
              {claim.data.message}. A deposit becomes claimable after the mark that accepts it, a redemption after the mark that settles it.
            </Callout>
          )}
          <TxRunner
            txs={claim.data.txs}
            signer={claim.data.signer}
            onConfirmed={() => {
              void refreshAfterTx(qc, utils);
            }}
          />
          {claim.data.txs.length > 0 && <p className="text-[12px] text-muted">Claims are never blocked by a pause or a kill. {CASH_WAIT_LINE} Gas is paid in ETH from this wallet.</p>}
        </div>
      ) : null}
    </Modal>
  );
}
