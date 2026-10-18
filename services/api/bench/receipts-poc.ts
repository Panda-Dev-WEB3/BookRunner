// AUDIT 2026-10 M-4 PoC benchmark: API CPU of receipts.proof through the Hono app (fake read model, no
// DB / network), for one closed mainnet-sized hour. Run: node_modules/bun/bin/bun.exe services/api/bench/receipts-poc.ts [leaves]
// Prints the CPU of a 10-call GET batch, of 10 unbatched calls, and the per-IP CPU per second at the old
// nginx limit (20 req/s of 10-call batches) vs the new receipts limit (2 req/s, one call per request).
import { RECEIPT_KIND, payloadHash } from "@bookrunner/shared";
import { createApp } from "../src/app";
import { hourlyTree } from "../src/domain/receipts";
import { NOW, makeWorld, seedBook } from "../test/fixtures";

const LEAVES = Number(process.argv[2] ?? 3000);
const HOUR = 3600;
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

function world() {
  const w = makeWorld();
  seedBook(w);
  w.deps.settings.receiptsIntervalSeconds = HOUR;
  const hourStart = new Date((Math.floor(NOW / 1000 / HOUR) - 2) * HOUR * 1000);
  const rows = [];
  for (let i = 0; i < LEAVES; i++) {
    const payload = { q: i, bid: 189.9 + i / 1000, ask: 190.1 + i / 1000 };
    rows.push({ id: 10_000 + i, bookId: 1, kind: RECEIPT_KIND.QUOTE, ts: new Date(hourStart.getTime() + (i % HOUR) * 1000), payload, payloadHash: payloadHash(payload), hourStart });
  }
  w.data.receipts.push(...rows);
  const t = hourlyTree(rows);
  w.data.receiptRoots.push({ id: 1, bookId: 1, hourStart, root: t.root, leafCount: t.count, createdAt: new Date(hourStart.getTime() + HOUR * 1000 + 60_000) });
  return { w, rows, app: createApp(w.deps, { origins: [] }) };
}

const input = (receiptId: number) => encodeURIComponent(JSON.stringify({ json: { receiptId } }));

async function main() {
  // warm up the JIT on a throwaway world
  {
    const { app, rows } = world();
    for (let i = 0; i < 3; i++) await app.request(`/trpc/receipts.proof?input=${input(rows[i]!.id)}`);
  }
  const runs = 5;
  let batchMs = 0;
  let batchStatus = 0;
  let coldMs = 0;
  let warmMs = 0;
  const warmCalls = 50;
  for (let r = 0; r < runs; r++) {
    // a 10-call batch on a cold process cache, ten different receipts of the hour
    const a = world();
    const ids = Array.from({ length: 10 }, (_, i) => a.rows[r * 10 + i]!.id);
    const batchInput = encodeURIComponent(JSON.stringify(Object.fromEntries(ids.map((id, i) => [String(i), { json: { receiptId: id } }]))));
    let t = cpuMs();
    const res = await a.app.request(`/trpc/${ids.map(() => "receipts.proof").join(",")}?batch=1&input=${batchInput}`);
    await res.text();
    batchMs += cpuMs() - t;
    batchStatus = res.status;
    // unbatched calls (what the web client sends): the first on a cold cache, then other receipts of the hour
    const b = world();
    t = performance.now();
    await (await b.app.request(`/trpc/receipts.proof?input=${input(b.rows[0]!.id)}`)).text();
    coldMs += performance.now() - t;
    t = performance.now();
    for (let i = 1; i <= warmCalls; i++) await (await b.app.request(`/trpc/receipts.proof?input=${input(b.rows[i]!.id)}`)).text();
    warmMs += (performance.now() - t) / warmCalls;
  }
  batchMs /= runs;
  coldMs /= runs;
  warmMs /= runs;
  console.log(`leaves per hour: ${LEAVES}`);
  console.log(`10-call GET batch of receipts.proof: HTTP ${batchStatus}, ${batchMs.toFixed(1)} ms CPU`);
  console.log(`unbatched receipts.proof: first call of the hour ${coldMs.toFixed(1)} ms, later calls ${warmMs.toFixed(2)} ms each`);
  console.log(`one IP at 20 req/s of 10-call batches (audited nginx limit): ~${((batchStatus === 200 ? batchMs : coldMs * 10) * 20 / 1000).toFixed(1)} s of API CPU per second (audited code)`);
  console.log(`one IP at the receipts limit (2 req/s, one call per request) on cached hours: ~${(warmMs * 2).toFixed(1)} ms of API CPU per second`);
}

await main();
