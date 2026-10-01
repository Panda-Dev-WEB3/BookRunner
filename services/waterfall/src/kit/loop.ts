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

export class AbortedError extends Error {
  constructor() {
    super("aborted");
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortedError();
}

/** Polls `check` every `everyMs` until it returns a value (not undefined), the timeout, or abort. */
export async function pollUntil<T>(check: () => Promise<T | undefined>, opts: { timeoutMs: number; everyMs: number; signal?: AbortSignal }): Promise<T | undefined> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    throwIfAborted(opts.signal);
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(opts.everyMs, Math.max(0, deadline - Date.now())), opts.signal);
  }
}

/** Retries `fn` with capped exponential backoff until it succeeds; null when aborted. */
export async function retryUntil<T>(what: string, fn: () => Promise<T>, opts: { log: Logger; signal: AbortSignal; baseMs?: number; maxMs?: number }): Promise<T | null> {
  for (let attempt = 1; !opts.signal.aborted; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const backoff = Math.min(opts.maxMs ?? 30_000, (opts.baseMs ?? 1_000) * 2 ** Math.min(attempt - 1, 10));
      opts.log.warn({ what, attempt, backoffMs: backoff, err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "startup step failed; retrying");
      await sleep(backoff, opts.signal);
    }
  }
  return null;
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
        if (ac.signal.aborted) break;
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
export function onShutdown(log: Logger, cleanup: () => Promise<void>, timeoutMs = 15_000) {
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
