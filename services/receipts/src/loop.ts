import type { Logger } from "@bookrunner/shared";

/** Cancellable sleep. Resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Periodic loop: never crashes on errors — logs and backs off exponentially (capped). */
export function startLoop(opts: { name: string; intervalMs: number; run: (signal: AbortSignal) => Promise<void>; log: Logger; maxBackoffMs?: number }) {
  const ac = new AbortController();
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const done = (async () => {
    let failures = 0;
    while (!ac.signal.aborted) {
      try {
        await opts.run(ac.signal);
        failures = 0;
        await sleep(opts.intervalMs, ac.signal);
      } catch (err) {
        failures++;
        const backoff = Math.min(maxBackoff, opts.intervalMs * 2 ** Math.min(failures, 10));
        opts.log.error({ err, loop: opts.name, failures, backoffMs: backoff }, "loop iteration failed; backing off");
        await sleep(backoff, ac.signal);
      }
    }
  })();
  return {
    signal: ac.signal,
    async stop() {
      ac.abort();
      await done;
    },
  };
}

/** SIGINT/SIGTERM -> run cleanup once, then exit (forced after timeoutMs). */
export function onShutdown(log: Logger, cleanup: () => Promise<void>, timeoutMs = 10_000) {
  let stopping = false;
  const handler = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, "shutting down");
    const force = setTimeout(() => {
      log.warn("forced exit after shutdown timeout");
      process.exit(1);
    }, timeoutMs);
    cleanup()
      .catch((err) => log.error({ err }, "shutdown cleanup failed"))
      .finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
  };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}
