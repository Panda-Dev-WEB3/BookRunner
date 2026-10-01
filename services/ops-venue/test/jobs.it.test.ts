// BullMQ wiring on Redis with a PRIVATE key prefix: BKRN_IT=1 [REDIS_URL=redis://127.0.0.1:63790] bun test test/jobs.it.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { QUEUES, type VenueOpsJob } from "@bookrunner/shared";
import { Queue, QueueEvents, Worker } from "bullmq";
import { keyFromSecret } from "../src/orderly/auth";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { OpsService } from "../src/worker/service";
import { BUILDER_ID, makeCtx, trackedBook } from "./helpers";

const enabled = process.env.BKRN_IT === "1";
const d = enabled ? describe : describe.skip;

d("venue-ops queue (BullMQ)", () => {
  const prefix = `bkrn-it-${Date.now()}`;
  const connection = { url: process.env.REDIS_URL ?? "redis://127.0.0.1:63790", maxRetriesPerRequest: null };
  const closers: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
  });

  test("create_symbol and revoke_key jobs run through the worker", async () => {
    const t = await makeCtx();
    t.chain.books = [trackedBook()];
    const svc = new OpsService(t.ctx, new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)));
    const worker = new Worker<VenueOpsJob>(QUEUES.venueOps, (job) => svc.handleJob(job.data), { connection, prefix });
    const queue = new Queue<VenueOpsJob>(QUEUES.venueOps, { connection, prefix });
    const events = new QueueEvents(QUEUES.venueOps, { connection, prefix });
    closers.push(() => worker.close(), () => queue.obliterate({ force: true }), () => queue.close(), () => events.close());
    await events.waitUntilReady();

    const j1 = await queue.add("create_symbol", { kind: "create_symbol", bookId: 1 });
    expect(await j1.waitUntilFinished(events, 15_000)).toEqual({ bookId: 1, symbol: "PERP_NVDA_USDC" });
    expect(t.mock.venue.requireSymbol("PERP_NVDA_USDC").ifAccountId).toBeTruthy();

    const j2 = await queue.add("revoke_key", { kind: "revoke_key", bookId: 1 }, { jobId: "revoke_key-1-ep1" });
    const r = (await j2.waitUntilFinished(events, 15_000)) as { revokedNow: boolean };
    expect(r.revokedNow).toBe(true);
    expect(t.store.events.map((e) => e.type)).toEqual(["agent.revoked"]);
  }, 30_000);
});
