// Builder prices to the venue for Orderly-venue books. One owner per mode:
//   mock: the oracle POSTs ORDERLY_BASE_URL/mock/price {symbol, price, held} (services/mock-orderly), below.
//   live: the oracle only publishes its signed prices per venue symbol (Redis KEYS.oracleVenueFeed, every tick);
//         ops-venue, which holds the builder's Orderly key, pushes them to Orderly's Builder Oracle WebSocket
//         (services/ops-venue/src/builderOracle, docs/VERIFY.md O18). No live client here.
import type { OrderlyBuilderApi } from "@bookrunner/shared";

export type BuilderPriceClient = Pick<OrderlyBuilderApi, "setBuilderPrice"> & { readonly mode: "mock" | "live" };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class MockOrderlyPriceClient implements BuilderPriceClient {
  readonly mode = "mock" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 2_000,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async setBuilderPrice(p: { symbol: string; price: number; held: boolean; ts: number }): Promise<void> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/mock/price`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: p.symbol, price: p.price, held: p.held }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`mock-orderly /mock/price ${p.symbol}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/** mock: the mock-orderly client; live: null (ops-venue pushes from the Redis venue feed). */
export function builderPriceClient(mode: "mock" | "live", baseUrl: string, timeoutMs?: number): BuilderPriceClient | null {
  return mode === "mock" ? new MockOrderlyPriceClient(baseUrl, timeoutMs) : null;
}
