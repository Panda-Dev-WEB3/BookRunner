// Sequential timer loop: never overlaps runs, never dies on an error (log + exponential backoff).
import type { Logger } from "@bookrunner/shared";

export interface Loop {
  stop(): Promise<void>;
}

/**
 * Runs `fn` every `intervalMs` (measured from the end of the previous run). `fn` may return a
 * number to override the next delay. Errors back off up to `maxBackoffMs`.
 */
export function startLoop(name: string, intervalMs: number, fn: () => Promise<number | void>, log: Logger, maxBackoffMs = 30_000): Loop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let failures = 0;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(run, ms);
  };

  const run = () => {
    timer = null;
    running = (async () => {
      let next = intervalMs;
      try {
        const r = await fn();
        if (typeof r === "number") next = r;
        if (failures > 0) log.info({ loop: name, after: failures }, "loop recovered");
        failures = 0;
      } catch (err) {
        failures++;
        next = Math.min(intervalMs * 2 ** Math.min(failures, 10), Math.max(maxBackoffMs, intervalMs));
        log.error({ loop: name, err: err instanceof Error ? err.message : String(err), failures, retryInMs: next }, "loop iteration failed");
      }
      running = null;
      schedule(next);
    })();
  };

  schedule(0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
