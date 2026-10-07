// Pure part of the prepared-transaction check TxRunner runs before any wallet prompt (wallet/txVerify.ts
// supplies the chain-derived contract addresses). Rules: @bookrunner/shared/preparedTx.
import { type DecodedStep, type PreparedCheck, type PreparedTxInput, verifyPreparedTxs } from "@bookrunner/shared/preparedTx";

export type FlowTargets = Required<Pick<PreparedCheck, "targets" | "labels" | "decimals">>;

export type TxCheck = { status: "pending" } | { status: "ok"; steps: DecodedStep[] } | { status: "refused"; error: string };

/** Verifies `txs` once the chain-derived targets are known (null: still loading -> pending). */
export function checkTxs(
  txs: readonly PreparedTxInput[],
  targets: FlowTargets | null,
  opts: { chainId: number; account?: string | null; amount?: bigint | null },
): TxCheck {
  if (!targets) return { status: "pending" };
  try {
    const steps = verifyPreparedTxs(txs, {
      chainId: opts.chainId,
      ...targets,
      ...(opts.account ? { account: opts.account } : {}),
      ...(opts.amount != null ? { amount: opts.amount } : {}),
    });
    return { status: "ok", steps };
  } catch (e) {
    return { status: "refused", error: e instanceof Error ? e.message : String(e) };
  }
}
