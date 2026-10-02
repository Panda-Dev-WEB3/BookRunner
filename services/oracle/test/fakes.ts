import { type OraclePriceMsg, type PriceUpdate, createLogger, devAccount } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { OracleChain, PushResult } from "../src/adapters/chain";
import type { PriceStore } from "../src/adapters/db";
import type { BundlePublication, PricePublisher } from "../src/adapters/redis";
import type { BuilderPriceClient } from "../src/adapters/venue";
import type { PriceSource } from "../src/domain/types";
import { OracleService, type OracleSettings } from "../src/service";
import { accountSigner } from "../src/signing";

export const silentLog = createLogger("oracle-test", "silent");
export const ORACLE_ADDR = "0x00000000000000000000000000000000000000AA" as Address;

/** A source whose answers are set by the test; observations without `ts` are stamped at fetch time. */
export class ScriptedSource implements PriceSource {
  readonly answers = new Map<string, { price: number; ts?: number } | null | Error>();
  constructor(
    readonly name: string,
    private readonly now: () => number = Date.now,
  ) {}
  set(ticker: string, v: { price: number; ts?: number } | null | Error) {
    this.answers.set(ticker, v);
  }
  async fetch(ticker: string) {
    const v = this.answers.get(ticker);
    if (v instanceof Error) throw v;
    return v ? { price: v.price, ts: v.ts ?? this.now() } : null;
  }
}

export class FakeChain implements OracleChain {
  readonly oracle = ORACLE_ADDR;
  readonly chainId = 31337;
  head: number | null = null;
  signer = true;
  min = 3;
  stored = new Map<string, number>();
  pushes: Array<{ updates: PriceUpdate[]; sigs: Hex[] }> = [];
  failNext: Error | null = null;
  /** the deployed AttestedOracle has update(bytes) (false = pre-low-gas contract) */
  pullContract = true;
  updateChecks = 0;
  private n = 0;

  async supportsUpdate() {
    this.updateChecks++;
    return this.pullContract;
  }

  async headTimestamp() {
    if (this.head === null) throw new Error("no chain");
    return this.head;
  }
  async isSigner(_a: Address) {
    return this.signer;
  }
  async minSources() {
    return this.min;
  }
  async latestPublishedAt(u: Hex) {
    return this.stored.get(u.toLowerCase()) ?? 0;
  }
  async pushMany(updates: readonly PriceUpdate[], sigs: readonly Hex[]): Promise<PushResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    for (const u of updates) {
      const prev = this.stored.get(u.underlying.toLowerCase()) ?? 0;
      if (Number(u.publishedAt) <= prev) throw new Error(`NotNewer(${prev}, ${u.publishedAt})`);
    }
    for (const u of updates) this.stored.set(u.underlying.toLowerCase(), Number(u.publishedAt));
    this.pushes.push({ updates: [...updates], sigs: [...sigs] });
    this.n++;
    return { txHash: `0x${this.n.toString(16).padStart(64, "0")}` as Hex, blockNumber: BigInt(this.n), status: "success" };
  }
}

export class FakePublisher implements PricePublisher {
  published: OraclePriceMsg[] = [];
  last = new Map<string, OraclePriceMsg>();
  bundles: BundlePublication[] = [];
  fail = false;
  async publish(msgs: readonly OraclePriceMsg[], bundle?: BundlePublication | null) {
    if (this.fail) throw new Error("redis down");
    for (const m of msgs) {
      this.published.push(m);
      this.last.set(m.priceId, m);
    }
    if (bundle) this.bundles.push(bundle);
  }
  async loadLast(priceId: string) {
    return this.last.get(priceId) ?? null;
  }
}

export class FakeStore implements PriceStore {
  rows: Array<{ msg: OraclePriceMsg; pushedTx: Hex | null }> = [];
  fail = false;
  async insertPrices(rows: ReadonlyArray<{ msg: OraclePriceMsg; pushedTx: Hex | null }>) {
    if (this.fail) throw new Error("db down");
    this.rows.push(...rows);
  }
}

export class FakeVenue implements BuilderPriceClient {
  readonly mode = "mock" as const;
  calls: Array<{ symbol: string; price: number; held: boolean; ts: number }> = [];
  async setBuilderPrice(p: { symbol: string; price: number; held: boolean; ts: number }) {
    this.calls.push(p);
  }
}

/** Heartbeat mode (the pre-low-gas push behaviour most tests pin); pull-mode tests override pushMode. */
export const DEFAULT_SETTINGS: OracleSettings = {
  outlierBps: 150,
  minSources: 3,
  maxSourceAgeMs: 15_000,
  sourceTimeoutMs: 500,
  pushIntervalMs: 5_000,
  pushDeviationBps: 25,
  sessionsMode: "24x7",
  venuePrices: true,
  pushMode: "heartbeat",
  bundleMaxAgeMs: 300_000,
};

export function makeService(p: {
  sources: PriceSource[];
  settings?: Partial<OracleSettings>;
  publisher?: FakePublisher | null;
  store?: FakeStore | null;
  venue?: BuilderPriceClient | null;
  now?: () => number;
}) {
  const publisher = p.publisher === undefined ? new FakePublisher() : p.publisher;
  const store = p.store === undefined ? new FakeStore() : p.store;
  const venue = p.venue === undefined ? new FakeVenue() : p.venue;
  const signerAccount = devAccount("oracleSigner");
  const svc = new OracleService({
    log: silentLog,
    sources: p.sources,
    signer: accountSigner(signerAccount),
    publisher,
    store,
    venue,
    settings: { ...DEFAULT_SETTINGS, ...p.settings },
    now: p.now ?? (() => 0),
  });
  return { svc, publisher, store, venue, signerAccount };
}
