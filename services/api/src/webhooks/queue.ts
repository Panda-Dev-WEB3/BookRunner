// BullMQ wiring for QUEUES.webhooks: producer (dispatcher) and worker (HTTP delivery).
import { type Logger, QUEUES, type WebhookJob } from "@bookrunner/shared";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { type DeliverDeps, deliverWebhook } from "./deliver";
import { WEBHOOK_MAX_ATTEMPTS, deliveryJobId, webhookJobOptions } from "./policy";

/** `prefix` namespaces BullMQ keys (default "bull"); integration tests use their own. */
export function createWebhookQueue(connection: ConnectionOptions, backoffMs: number, prefix?: string, log?: Logger) {
  const queue = new Queue<WebhookJob>(QUEUES.webhooks, { connection, defaultJobOptions: webhookJobOptions(backoffMs), ...(prefix ? { prefix } : {}) });
  // without a listener an 'error' event on the queue is unhandled (Redis outages)
  queue.on("error", (err) => log?.debug({ err }, "webhook queue error"));
  const enqueue = async (job: WebhookJob) => {
    await queue.add("deliver", job, { ...webhookJobOptions(backoffMs), jobId: deliveryJobId(job.subscriptionId, job.eventId) });
  };
  return { queue, enqueue };
}

export function createWebhookWorker(connection: ConnectionOptions, deps: DeliverDeps, concurrency: number, log: Logger, prefix?: string) {
  const worker = new Worker<WebhookJob>(
    QUEUES.webhooks,
    async (job: Job<WebhookJob>) => {
      const max = job.opts.attempts ?? WEBHOOK_MAX_ATTEMPTS;
      const outcome = await deliverWebhook(deps, job.data, job.attemptsMade + 1, max);
      if (outcome.status === "retry" || outcome.status === "failed") throw new Error(outcome.error);
      return outcome;
    },
    { connection, concurrency, ...(prefix ? { prefix } : {}) },
  );
  let lastWarn = 0;
  worker.on("error", (err) => {
    if (Date.now() - lastWarn < 30_000) return; // Redis outages emit one error per reconnect attempt
    lastWarn = Date.now();
    log.warn({ err }, "webhook worker error (repeats suppressed for 30s)");
  });
  return worker;
}
