// PoolEngine (2026-10 liquidation keeper): Trade / MarginChanged / Liquidation / ClosedOut -> engine_positions, the
// keeper's trader set; a re-applied range or an older log never overwrites a newer row.
import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import { poolEngineAbi } from "@bookrunner/shared/abi";
import type { Address } from "viem";
import { CURSORS } from "../src/config";
import { Indexer } from "../src/runner";
import { WatchSet } from "../src/watch";
import { FakeChain, MemoryIndexerStore, makeLog } from "./helpers";
import { DEPLOYMENT } from "./scenario";

const logger = createLogger("indexer-engine-test", "silent");
const ENGINE = "0x00000000000000000000000000000000000000e9" as Address;
const ALICE = "0x0000000000000000000000000000000000000a11" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const KEEPER = "0x000000000000000000000000000000000000beef" as Address;
const UNIT = 10n ** 18n;

function world() {
  const chain = new FakeChain();
  const L = (name: string, args: Record<string, unknown>, block: number, logIndex: number, tx: number) => chain.logs.push(makeLog(poolEngineAbi, name, args, { address: ENGINE, block, logIndex, tx }));
  const deployment = { ...DEPLOYMENT, contracts: { ...(DEPLOYMENT.contracts as object), poolEngine: ENGINE } as never };
  const store = new MemoryIndexerStore();
  const make = () => new Indexer({ store, chain, watch: new WatchSet(deployment), deployment, publisher: null, logger, config: { confirmations: 0, batchBlocks: 2000, poisonAttempts: 3, startBlock: 1 } });
  // alice deposits then opens long 10, bob deposits and opens short 2; funding events are ignored
  L("MarginChanged", { marketId: 1n, trader: ALICE, delta: 110_000_000n }, 1, 0, 1);
  L("Trade", { marketId: 1n, trader: ALICE, sizeDelta: 10n * UNIT, fillPriceWad: 100n * UNIT, feeUsd: 1n, realizedPnlUsd: 0n, newSize: 10n * UNIT }, 2, 0, 2);
  L("MarginChanged", { marketId: 1n, trader: BOB, delta: 50_000_000n }, 2, 1, 3);
  L("Trade", { marketId: 1n, trader: BOB, sizeDelta: -2n * UNIT, fillPriceWad: 100n * UNIT, feeUsd: 1n, realizedPnlUsd: 0n, newSize: -2n * UNIT }, 3, 0, 4);
  L("FundingAccrued", { marketId: 1n, fundingIndex: 5n, indexDelta: 5n }, 3, 1, 4);
  // a top-up keeps alice's size; then a keeper liquidates her; bob is closed out
  L("MarginChanged", { marketId: 1n, trader: ALICE, delta: 1_000_000n }, 4, 0, 5);
  L("Liquidation", { marketId: 1n, trader: ALICE, liquidator: KEEPER, size: 10n * UNIT, priceWad: 93n * UNIT, feeUsd: 1n, badDebtUsd: 0n }, 5, 0, 6);
  L("Trade", { marketId: 1n, trader: BOB, sizeDelta: 2n * UNIT, fillPriceWad: 100n * UNIT, feeUsd: 0n, realizedPnlUsd: 0n, newSize: 0n }, 6, 0, 7);
  L("ClosedOut", { marketId: 1n, trader: BOB, by: KEEPER, size: -2n * UNIT, priceWad: 100n * UNIT, badDebtUsd: 0n }, 6, 1, 7);
  return { chain, store, make };
}

async function drain(ix: Indexer) {
  for (let i = 0; i < 20; i++) if ((await ix.step()).status === "idle") return;
}

describe("engine positions", () => {
  test("the trader set follows the engine's events", async () => {
    const { chain, store, make } = world();
    chain.head = 4n;
    await drain(make());
    const k = (t: Address) => `1|${t.toLowerCase()}`;
    expect(store.s.enginePositions[k(ALICE)]).toMatchObject({ sizeRaw: (10n * UNIT).toString(), lastBlock: 4 });
    expect(store.s.enginePositions[k(BOB)]).toMatchObject({ sizeRaw: (-2n * UNIT).toString() });
    chain.head = 6n;
    await drain(make());
    expect(store.s.enginePositions[k(ALICE)]?.sizeRaw).toBe("0");
    expect(store.s.enginePositions[k(BOB)]).toMatchObject({ sizeRaw: "0", lastBlock: 6, lastLogIndex: 1 });
  });

  test("idempotent: a re-applied range and an older log change nothing", async () => {
    const { chain, store, make } = world();
    chain.head = 6n;
    await drain(make());
    const before = JSON.stringify(store.s.enginePositions);
    await store.setCursor(CURSORS.protocol, 0);
    await store.setCursor(CURSORS.books, 0);
    await drain(make());
    expect(JSON.stringify(store.s.enginePositions)).toBe(before);
    await store.upsertEnginePosition({ marketId: 1, trader: ALICE, sizeRaw: "5", lastBlock: 2, lastLogIndex: 0 });
    expect(store.s.enginePositions[`1|${ALICE.toLowerCase()}`]?.sizeRaw).toBe("0");
  });
});

describe("engine positions backfill (review I-5)", () => {
  test("an index older than the engine watch backfills the engine's history up to the protocol cursor, engine logs only", async () => {
    const { chain, store, make } = world();
    chain.head = 6n;
    // the index ran before this version: its protocol cursor is past the engine's events, no engine rows
    await store.setCursor(CURSORS.protocol, 6);
    await store.setCursor(CURSORS.books, 6);
    const ix = make();
    for (let i = 0; i < 5; i++) await ix.backfillEngine();
    const k = (t: Address) => `1|${t.toLowerCase()}`;
    expect(store.s.enginePositions[k(ALICE)]?.sizeRaw).toBe("0");
    expect(store.s.enginePositions[k(BOB)]).toMatchObject({ sizeRaw: "0", lastBlock: 6 });
    expect(await store.getCursor(CURSORS.engineBackfill)).toBe(6);
    expect(chain.getLogsCalls.every((c) => c.addresses.length === 1 && c.addresses[0]!.toLowerCase() === ENGINE.toLowerCase())).toBe(true);
    // caught up: nothing more is read
    const calls = chain.getLogsCalls.length;
    expect(await ix.backfillEngine()).toBeNull();
    expect(chain.getLogsCalls.length).toBe(calls);
  });

  test("a fresh index covers the engine from its first range: no backfill scan", async () => {
    const { chain, store, make } = world();
    chain.head = 6n;
    await drain(make());
    expect(await store.getCursor(CURSORS.engineBackfill)).toBe(6);
    const calls = chain.getLogsCalls.length;
    expect(await make().backfillEngine()).toBeNull();
    expect(chain.getLogsCalls.length).toBe(calls);
  });
});
