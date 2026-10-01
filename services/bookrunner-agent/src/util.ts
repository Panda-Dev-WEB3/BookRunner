// Small runtime helpers: abortable sleep, serial lock, backoff, error formatting.

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Runs async sections one at a time (desk key nonce safety, venue cancel/replace ordering). */
export class SerialLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function backoffMs(failures: number, baseMs = 1_000, maxMs = 30_000): number {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 10));
}

/** Short, log-friendly error text (viem errors carry a shortMessage). */
export function errMsg(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: unknown; message?: unknown; cause?: { reason?: unknown; data?: { errorName?: unknown } } };
    const name = e.cause?.data?.errorName;
    const base = typeof e.shortMessage === "string" ? e.shortMessage : typeof e.message === "string" ? e.message : String(err);
    return typeof name === "string" && !base.includes(name) ? `${base} (${name})` : base.split("\n")[0] ?? base;
  }
  return String(err);
}

/** Custom error name from a viem ContractFunctionRevertedError chain, if any. */
export function revertName(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const c = cur as { data?: { errorName?: unknown }; cause?: unknown };
    if (typeof c.data?.errorName === "string") return c.data.errorName;
    cur = c.cause;
  }
  return null;
}
