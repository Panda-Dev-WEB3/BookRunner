// BullMQ producer for QUEUES.venueOps (consumed by ops-venue). Job name = job.kind; the custom
// jobId makes enqueueing idempotent per kill episode (BullMQ ignores a duplicate jobId).
import { QUEUES, type VenueOpsJob } from "@bookrunner/shared";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { QueuePort } from "../ports";
import { withTimeout } from "../util/async";

export class BullVenueOpsQueue implements QueuePort {
  private readonly queue: Queue;

  constructor(
    connection: Redis,
    private readonly timeoutMs: number,
    onError: (err: Error) => void,
  ) {
    this.queue = new Queue(QUEUES.venueOps, { connection });
    this.queue.on("error", onError);
  }

  async enqueueVenueOp(job: VenueOpsJob, jobId: string): Promise<void> {
    await withTimeout(
      this.queue.add(job.kind, job, {
        jobId: jobId.replaceAll(":", "-"),
        attempts: 10,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      }),
      this.timeoutMs,
      `enqueue ${QUEUES.venueOps}`,
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
