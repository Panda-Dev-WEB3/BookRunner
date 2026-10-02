// Signed off-chain inputs for risk (docs/LOW_GAS.md §1-§2): the oracle service's signed prints and
// ops-venue's signed venue reports, read from Redis and verified (signature + on-chain signer role) by the
// mark service's feed reader (services/mark/src/adapters/feeds.ts), so risk and the mark value the same
// inputs the same way. Prints are shared by every book monitor: one read + verification per `ttlMs`.
import type { SignedVenueReport } from "../../../ops-venue/src/report712";
import { type SignedPrice, newestByUnderlying } from "../../../mark/src/domain/prices";
import type { SignedFeedsPort, SignedPriceMap } from "../ports";
import type { BookRef } from "../types";
import { withTimeout } from "../util/async";

/** The verified feed reader (RedisMarkFeeds in production). */
export interface VerifiedFeeds {
  signedPrices(): Promise<SignedPrice[]>;
  venueReports(ref: Pick<BookRef, "bookId" | "venue" | "components">): Promise<SignedVenueReport[]>;
}

export class CachedSignedFeeds implements SignedFeedsPort {
  private cached: { at: number; value: SignedPriceMap } | null = null;
  private inflight: Promise<SignedPriceMap> | null = null;

  constructor(
    private readonly inner: VerifiedFeeds,
    private readonly o: { ttlMs: number; timeoutMs: number; now?: () => number },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async prices(): Promise<SignedPriceMap> {
    const hit = this.cached;
    if (hit && this.now() - hit.at < this.o.ttlMs) return hit.value;
    this.inflight ??= withTimeout(this.inner.signedPrices(), this.o.timeoutMs, "signed prices")
      .then((list) => {
        const value = newestByUnderlying(list);
        this.cached = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  venueReports(ref: BookRef): Promise<SignedVenueReport[]> {
    return withTimeout(this.inner.venueReports(ref), this.o.timeoutMs, "signed venue reports");
  }
}
