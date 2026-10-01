// Integration (BKRN_IT=1 + BKRN_ANVIL_URL): real RPC path (ViemIndexerChain: getLogs, block
// timestamps, tx input reads) + PgIndexerStore. Contracts are replaced by a tiny log emitter set via
// anvil_setCode at the protocol / component addresses, so the test needs no Foundry build.
// Run against a PRIVATE anvil, e.g. `anvil --port 18547 --silent`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, books, charters, createDb } from "@bookrunner/db";
import { createLogger, devAccount, localChain, strToBytes32 } from "@bookrunner/shared";
import { bookAbi, bookFactoryAbi, markRegistryAbi, mMMandateAbi, trancheAbi } from "@bookrunner/shared/abi";
import { sql } from "drizzle-orm";
import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  numberToHex,
  padHex,
} from "viem";
import { ViemIndexerChain } from "../src/chain";
import { CURSORS } from "../src/config";
import { PgIndexerStore } from "../src/pgStore";
import { Indexer } from "../src/runner";
import { WatchSet } from "../src/watch";
import { makeLog } from "./helpers";
import { ADDR, CHARTER_JSON, COMPONENTS } from "./scenario";

const url = process.env.DATABASE_URL ?? "";
const rpc = process.env.BKRN_ANVIL_URL ?? "";
const IT = process.env.BKRN_IT === "1" && rpc !== "" && /\/[a-z0-9_]+_it(\?|$)/.test(url);

/**
 * Log emitter runtime: calldata = [n:32][topic1..topicn:32 each][data] -> LOGn(data, topics...).
 *   00 PUSH1 0 CALLDATALOAD DUP1 PUSH1 32 MUL PUSH1 32 ADD   ; n, off = 32 + 32n
 *   0a DUP1 CALLDATASIZE SUB                                 ; size = cds - off
 *   0d DUP1 DUP3 PUSH1 0 CALLDATACOPY                        ; mem[0..size] = data
 *   12 (DUP3 PUSH1 k EQ PUSH1 Lk JUMPI) for k = 1..4, STOP
 *   2f L1: JUMPDEST t1 DUP2 PUSH1 0 LOG1 STOP
 *   38 L2: JUMPDEST t2 t1 DUP3 PUSH1 0 LOG2 STOP
 *   44 L3: JUMPDEST t3 t2 t1 DUP4 PUSH1 0 LOG3 STOP
 *   53 L4: JUMPDEST t4 t3 t2 t1 DUP5 PUSH1 0 LOG4 STOP
 */
export const EMITTER_RUNTIME: Hex = `0x${[
  "600035806020026020018036038082600037",
  "82600114602f57",
  "826002146038" + "57",
  "826003146044" + "57",
  "826004146053" + "57",
  "00",
  "5b602035816000a100",
  "5b604035602035826000a200",
  "5b606035604035602035836000a300",
  "5b608035606035604035602035846000a400",
].join("")}`;

describe.skipIf(!IT)("indexer over a real RPC (anvil + emitter contracts)", () => {
  // clients are created in beforeAll: the describe body also runs when the suite is skipped
  let pub: PublicClient;
  let wallet: WalletClient<Transport, Chain, Account>;
  let db: Db;
  let close: () => Promise<void>;
  let store: PgIndexerStore;
  let startBlock = 0;

  const emit = async (abi: Abi, address: Address, name: string, args: Record<string, unknown>) => {
    const l = makeLog(abi, name, args, { address, block: 0, logIndex: 0, tx: 0 });
    const data = concatHex([numberToHex(l.topics.length, { size: 32 }), ...l.topics.map((t) => padHex(t, { size: 32 })), l.data]);
    const hash = await wallet.sendTransaction({ to: address, data });
    await pub.waitForTransactionReceipt({ hash });
  };

  beforeAll(async () => {
    const chain = defineChain({ ...localChain, rpcUrls: { default: { http: [rpc] } } });
    pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
    wallet = createWalletClient({ chain, transport: http(rpc), account: devAccount("deployer") });
    ({ db, close } = createDb(url, 2));
    store = PgIndexerStore.create(db);
    for (const t of ["charters", "books", "subscriptions", "marks", "agent_keys", "events", "chain_cursor"]) await db.execute(sql.raw(`delete from ${t}`)); // private *_it database only
    for (const a of [ADDR.charter, ADDR.committee, ADDR.factory, ADDR.markRegistry, ADDR.book, ADDR.senior, ADDR.junior, ADDR.router, ADDR.mandate]) {
      await pub.request({ method: "anvil_setCode" as never, params: [a, EMITTER_RUNTIME] as never });
    }
    // the filing was indexed earlier (MarketCharter.get needs the real contract)
    await db.insert(charters).values({ id: 1, sponsor: ADDR.sponsor, structJson: CHARTER_JSON, status: "Approved", underlying: CHARTER_JSON.underlying, symbol: "PERP_NVDA_USDC", venue: 0, filedAt: new Date() });
    startBlock = Number(await pub.getBlockNumber()) + 1;
    const U = (n: number) => BigInt(n) * 1_000_000n;
    await emit(bookFactoryAbi, ADDR.factory, "BookCreated", { bookId: 1n, book: ADDR.book, components: COMPONENTS });
    await emit(trancheAbi, ADDR.senior, "Committed", { wallet: ADDR.wallet, receiver: ADDR.wallet, assets: U(70000), round: 0n });
    await emit(bookAbi, ADDR.book, "WindowClosed", { bookId: 1n, seniorAllocated: U(70000), juniorAllocated: U(30000), seniorCommitted: U(70000), juniorCommitted: U(30000) });
    await emit(mMMandateAbi, ADDR.mandate, "KeyRegistered", { key: ADDR.key, operator: ADDR.operator, validUntil: 0n, inventoryTierUsd: U(50000) });
    await emit(markRegistryAbi, ADDR.markRegistry, "MarkCommitted", {
      markId: 7n, bookId: 1n, periodEnd: 1_790_000_100n, navUsd: U(100000), deployedValueUsd: U(100000),
      inventoryRoot: strToBytes32("i"), pnlJsonHash: strToBytes32("p"), receiptsRoot: strToBytes32("r"), signer: ADDR.operator,
    });
  }, 60_000);
  afterAll(async () => {
    await close();
  });

  test("indexes emitted logs through viem and advances the cursors to head", async () => {
    const deployment = { books: [], contracts: { charter: ADDR.charter, committee: ADDR.committee, factory: ADDR.factory, markRegistry: ADDR.markRegistry } as never };
    const ix = new Indexer({
      store,
      chain: new ViemIndexerChain(31337, rpc, { charter: ADDR.charter, markRegistry: ADDR.markRegistry }),
      watch: new WatchSet(deployment),
      deployment,
      publisher: null,
      logger: createLogger("indexer-anvil-it", "silent"),
      config: { confirmations: 0, batchBlocks: 2000, poisonAttempts: 3, startBlock },
    });
    await ix.init();
    const r = await ix.step();
    expect(r.status).toBe("indexed");
    expect(r.status === "indexed" && r.applied).toBe(5);
    const head = Number(await pub.getBlockNumber());
    expect(await store.getCursor(CURSORS.protocol)).toBe(head);
    const b = (await db.select().from(books))[0]!;
    expect(b.state).toBe("Live");
    expect(b.seniorAddr).toBe(ADDR.senior);
    expect(b.createdAt.getTime()).toBeGreaterThan(0);
    const sub = (await db.execute(sql`select kind, assets from subscriptions`)) as unknown as Array<Record<string, unknown>>;
    expect(sub).toEqual([{ kind: "commit", assets: "70000.000000" }]);
    const mark = (await db.execute(sql`select signature, applied_tx from marks where id = 7`)) as unknown as Array<Record<string, unknown>>;
    expect(mark).toEqual([{ signature: "", applied_tx: null }]); // not a direct commit() tx
    expect((await ix.step()).status).toBe("idle");
  }, 60_000);
});
