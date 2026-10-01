// Builder prices to the venue for Orderly-venue books.
//   mock: POST ORDERLY_BASE_URL/mock/price {symbol, price, held} (services/mock-orderly).
//   live: VERIFY — Orderly builder ("Perp Anything") price-source endpoint, auth and payload are
//         unverified; the live client refuses with NotConfiguredError instead of guessing.
import type { OrderlyBuilderApi } from "@bookrunner/shared";

export type BuilderPriceClient = Pick<OrderlyBuilderApi, "setBuilderPrice"> & { readonly mode: "mock" | "live" };

export class NotConfiguredError extends Error {
  override readonly name = "NotConfiguredError";
}

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

export class LiveOrderlyPriceClient implements BuilderPriceClient {
  readonly mode = "live" as const;
  async setBuilderPrice(p: { symbol: string; price: number; held: boolean; ts: number }): Promise<void> {
    throw new NotConfiguredError(
      `live Orderly builder price push for ${p.symbol} is not configured: VERIFY the builder price-source endpoint ` +
        "(candidate POST /v1/builder/symbol/price_source), its auth scheme and payload against Orderly docs before enabling",
    );
  }
}

export function builderPriceClient(mode: "mock" | "live", baseUrl: string, timeoutMs?: number): BuilderPriceClient {
  return mode === "mock" ? new MockOrderlyPriceClient(baseUrl, timeoutMs) : new LiveOrderlyPriceClient();
}
