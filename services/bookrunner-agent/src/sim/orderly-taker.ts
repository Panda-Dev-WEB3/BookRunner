// Taker flow against the local mock-orderly simulator: POST /mock/taker {symbol, side, qty}
// (packages/shared/src/orderly.ts). The mock crosses the order against the book's resting quotes.

import type { Side } from "@bookrunner/shared";
import type { FetchLike } from "../venues/orderly";

export class MockOrderlyTaker {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async take(symbol: string, side: Side, qty: number): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/mock/taker`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, side, qty }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mock taker ${symbol} ${side} ${qty} -> ${res.status}: ${text.slice(0, 200)}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }
}
