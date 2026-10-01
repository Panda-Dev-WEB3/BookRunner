import { type FillMsg, type Mandate, type QuoteMsg, createLogger, usd } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { AgentBus } from "../src/adapters/bus";
import type { AgentStore, FillRow, HedgeRow, QuoteRow } from "../src/adapters/store";
import type { ReceiptRow } from "../src/domain/receipts";

export const silentLog = createLogger("test", "silent");

/** NVDA launch mandate: 50k / 25 / 8 / 5000-12000 / -800. */
export function nvdaMandate(over: Partial<Mandate> = {}): Mandate {
  return {
    maxInventoryUsd: usd(50_000),
    maxSkewBps: 25,
    minQuoteWidthBps: 8,
    maxHedgeLeverage: 100,
    hedgeRatioMinBps: 5_000,
    hedgeRatioMaxBps: 12_000,
    noNewRiskOffHours: true,
    killAtDrawdownBps: -800,
    hedgeAllowRoot: ("0x" + "00".repeat(32)) as Hex,
    ...over,
  };
}

export class FakeBus implements AgentBus {
  quotes: QuoteMsg[] = [];
  fills: FillMsg[] = [];
  cleared = 0;
  heartbeats = 0;
  kv = new Map<string, unknown>();
  subs = new Map<string, Array<(raw: string) => void>>();
  async publishQuote(q: QuoteMsg): Promise<void> {
    this.quotes.push(q);
  }
  async clearQuote(): Promise<void> {
    this.cleared++;
  }
  async publishFill(f: FillMsg): Promise<void> {
    this.fills.push(f);
  }
  async heartbeat(): Promise<void> {
    this.heartbeats++;
  }
  async getJson<T>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T | undefined) ?? null;
  }
  async subscribe(channel: string, handler: (raw: string) => void): Promise<void> {
    this.subs.set(channel, [...(this.subs.get(channel) ?? []), handler]);
  }
  async close(): Promise<void> {}
}

export class FakeStore implements AgentStore {
  quotes: Array<{ row: QuoteRow; receipt: ReceiptRow | null }> = [];
  fills: FillRow[] = [];
  fillReceipts: ReceiptRow[] = [];
  hedges: Array<{ row: HedgeRow; receipt: ReceiptRow }> = [];
  failFills = 0;
  async insertQuote(row: QuoteRow, receipt: ReceiptRow | null): Promise<void> {
    this.quotes.push({ row, receipt });
  }
  async insertFills(rows: FillRow[], receiptsFor: (inserted: FillRow[]) => ReceiptRow[]): Promise<string[]> {
    if (this.failFills > 0) {
      this.failFills--;
      throw new Error("db down");
    }
    const have = new Set(this.fills.map((f) => f.venueTradeId));
    const ins = rows.filter((r) => !have.has(r.venueTradeId));
    this.fills.push(...ins);
    this.fillReceipts.push(...receiptsFor(ins));
    return ins.map((r) => r.venueTradeId);
  }
  async insertHedge(row: HedgeRow, receipt: ReceiptRow): Promise<void> {
    this.hedges.push({ row, receipt });
  }
  async lastFillTs(): Promise<number | null> {
    return null;
  }
}
