import { type Deployment, type Logger, deploymentPath, tryLoadDeployment } from "@bookrunner/shared";
import type { PublicClient } from "viem";
import { sleep } from "./loop";

/**
 * Waits (idling, logging) until the deployment file exists and its config contract has code on the
 * RPC (a fresh/reset anvil has none). Returns null only when aborted.
 */
export async function waitForDeployment(opts: {
  file: string;
  log: Logger;
  signal: AbortSignal;
  publicClient?: PublicClient;
  pollMs?: number;
}): Promise<Deployment | null> {
  const poll = opts.pollMs ?? 5_000;
  let lastReason = "";
  while (!opts.signal.aborted) {
    let reason = "";
    const d = tryLoadDeployment(opts.file);
    if (!d) reason = `deployment file missing: ${deploymentPath(opts.file)}`;
    else if (opts.publicClient) {
      try {
        const code = await opts.publicClient.getCode({ address: d.contracts.config });
        if (!code || code === "0x") reason = `no contract code at config ${d.contracts.config} (chain reset?)`;
      } catch (err) {
        reason = `rpc unavailable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      }
    }
    if (!reason && d) {
      if (lastReason) opts.log.info({ file: deploymentPath(opts.file) }, "deployment available");
      return d;
    }
    if (reason !== lastReason) opts.log.warn({ reason, retryMs: poll }, "waiting for deployment; idling");
    lastReason = reason;
    await sleep(poll, opts.signal);
  }
  return null;
}
