// Robust per-book loop: a failed tick (RPC / DB / Redis) is logged and retried with exponential
// backoff; the loop only exits when `signal` aborts, and always lets the in-flight tick finish
// (a running kill sequence is never cut in half by a shutdown).
import type { Logger } from "@bookrunner/shared";
import { abortableSleep, backoffMs, errMsg } from "./util/async";

export interface Tickable {
  tick(): Promise<unknown>;
  readonly log: Logger;
}

export const MAX_BACKOFF_MS = 30_000;

export async function runMonitorLoop(m: Tickable, signal: AbortSignal, intervalMs: number, now: () => number = Date.now): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const t0 = now();
    try {
      await m.tick();
      if (failures) m.log.info({ failures }, "risk tick recovered");
      failures = 0;
    } catch (err) {
      failures++;
      const level = failures <= 3 || failures % 30 === 0 ? "warn" : "debug";
      m.log[level]({ err: errMsg(err), failures }, "risk tick failed; backing off");
    }
    const wait = failures ? backoffMs(failures, intervalMs, MAX_BACKOFF_MS) : Math.max(0, intervalMs - (now() - t0));
    await abortableSleep(wait, signal);
  }
}
