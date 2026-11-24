// Small async helpers: sleep (abortable), timeouts, retries with backoff, a FIFO mutex.

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Sleep that resolves early when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  sleep?: Sleep;
  onError?: (err: unknown, attempt: number) => void;
}

/** Runs `fn` up to `attempts` times with exponential backoff; rethrows the last error. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const doSleep = o.sleep ?? sleep;
  let last: unknown;
  for (let attempt = 1; attempt <= Math.max(1, o.attempts); attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      o.onError?.(err, attempt);
      if (attempt < o.attempts) await doSleep(backoffMs(attempt, o.baseDelayMs, o.maxDelayMs ?? 30_000));
    }
  }
  throw last;
}

/** base * 2^(attempt-1), capped. attempt starts at 1. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** FIFO mutex: serialises on-chain writes from the single RISK account (nonce safety). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return (err as Error & { shortMessage?: string }).shortMessage ?? err.message;
  return String(err);
}
