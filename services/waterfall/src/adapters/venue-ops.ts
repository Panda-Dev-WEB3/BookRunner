// QUEUES.venueOps producer (ops-venue consumes): Orderly fee settlement sweep per (book, period).
import type { VenueOpsJob } from "@bookrunner/shared";
import type { Queue } from "bullmq";
import type { SweepJobState, VenueOps } from "../ports";

/** BullMQ job ids may not contain ':' (unless exactly 3 parts) — use '-'. */
export const sweepJobId = (bookId: number, period: number) => `sweep_fees-${bookId}-${period}`;

export class BullVenueOps implements VenueOps {
  constructor(private readonly queue: Queue) {}

  async enqueueSweep(bookId: number, period: number): Promise<void> {
    const data: VenueOpsJob = { kind: "sweep_fees", bookId, period };
    await this.queue.add("sweep_fees", data, {
      jobId: sweepJobId(bookId, period),
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    });
  }

  async sweepJobState(bookId: number, period: number): Promise<SweepJobState> {
    const job = await this.queue.getJob(sweepJobId(bookId, period));
    if (!job) return "missing";
    const s = await job.getState();
    if (s === "completed") return "completed";
    if (s === "failed") return "failed";
    return "pending";
  }
}
