import type { Logger } from "@bookrunner/shared";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Serialises async sections (global, or per key). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class KeyedMutex {
  private locks = new Map<string, Mutex>();
  run<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
    const k = String(key);
    let m = this.locks.get(k);
    if (!m) {
      m = new Mutex();
      this.locks.set(k, m);
    }
    return m.run(fn);
  }
}

/**
 * Periodic loop that never crashes: errors are logged and the next run is delayed with exponential
 * backoff (capped), reset after a success. Resolves when `signal` aborts.
 */
export async function runLoop(name: string, intervalMs: number, fn: () => Promise<void>, signal: AbortSignal, log: Logger, maxBackoffMs = 60_000): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await fn();
      failures = 0;
    } catch (err) {
      failures++;
      log.warn({ loop: name, failures, err: errMsg(err) }, "loop iteration failed");
    }
    const wait = failures === 0 ? intervalMs : Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 6));
    await sleep(wait, signal);
  }
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return (err as Error & { shortMessage?: string }).shortMessage ?? err.message;
  return String(err);
}

export const nowSec = (now = Date.now()) => Math.floor(now / 1000);
