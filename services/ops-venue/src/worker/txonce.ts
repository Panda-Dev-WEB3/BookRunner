// At-most-once on-chain writes for sagas. A saga step records each tx it broadcasts (hash + nonce, via
// WriteOpts.onSent) BEFORE the receipt is awaited. If the receipt wait fails (timeout, RPC hiccup) or the
// process crashes, the retry inspects the recorded tx instead of sending a second one:
//   success   -> the step's tx already landed: reuse it, send nothing
//   pending   -> still in the mempool: wait (caller returns "waiting")
//   dropped   -> gone, nonce unused: re-send with the SAME nonce (only one of the two can ever be mined)
//   replaced / reverted -> it can never land / it failed: re-send with a fresh nonce
// The only remaining gap is a crash between broadcast and the synchronous record() call; steps whose
// effect is visible on-chain (confirm, earmark) additionally check that state before sending.
import type { Hex } from "viem";
import type { ChainPort, SentTx, WriteOpts } from "../chain";

export type OnceResult<T> = { kind: "sent"; value: T } | { kind: "mined"; hash: Hex } | { kind: "pending"; hash: Hex };

export async function sendOnce<T>(
  chain: ChainPort,
  prior: SentTx | undefined,
  record: (tx: SentTx) => void,
  send: (opts: WriteOpts) => Promise<T>,
): Promise<OnceResult<T>> {
  let nonce: number | undefined;
  if (prior) {
    const st = await chain.txState(prior);
    if (st === "success") return { kind: "mined", hash: prior.hash };
    if (st === "pending") return { kind: "pending", hash: prior.hash };
    if (st === "dropped") nonce = prior.nonce;
  }
  const value = await send({ onSent: record, ...(nonce !== undefined ? { nonce } : {}) });
  return { kind: "sent", value };
}
