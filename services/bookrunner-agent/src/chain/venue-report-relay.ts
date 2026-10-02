// Low-gas mode (docs/LOW_GAS.md §2): ops-venue signs Orderly venue reports off-chain every minute, and the
// adapter's on-chain valuation only advances at marks (hourly / daily). Two consequences for the agent:
//  - planning: the hedger must size against the latest SIGNED report (what risk monitors), not the
//    on-chain adapter view, which can be up to one mark interval old;
//  - execution: MMMandate band-checks every hedge leg against the on-chain exposure (and a hedge-adding
//    leg also needs valuationAt within 4 x maxPriceAge), so the agent relays the latest signed report
//    with OrderlyAdapter.reportSigned right before each hedge leg. The relay is a no-op when the chain is
//    already as fresh, and best-effort: a failed relay never blocks the leg (the mandate then refuses it).
import { orderlyAdapterAbi } from "@bookrunner/shared/abi";
import type { Logger } from "@bookrunner/shared";
import { Redis } from "ioredis";
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import { type SignedVenueReport, parseSignedVenueReport, venueReportKey } from "../../../ops-venue/src/report712";

export interface VenueReportRelayDeps {
  redisUrl: string;
  bookId: number;
  chainId: number;
  adapter: Address;
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  log: Logger;
}

export interface VenueReportRelay {
  /** Latest signed report for this book/adapter/chain from Redis (off-chain, free); null when none. */
  latest(): Promise<SignedVenueReport | null>;
  /** Freshest venue view: the signed report when newer than the on-chain one, else the on-chain view. */
  view(): Promise<{ exposureUsd: bigint; valuationAt: number }>;
  /** Push the latest signed report on-chain when it is newer than adapter.valuationAt. Never throws. */
  relay(): Promise<void>;
}

export function makeVenueReportRelay(d: VenueReportRelayDeps): VenueReportRelay {
  const redis = new Redis(d.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  const read = <T>(functionName: "valuationAt" | "netExposureUsd") =>
    d.pub.readContract({ address: d.adapter, abi: orderlyAdapterAbi, functionName }) as Promise<T>;

  const latest = async (): Promise<SignedVenueReport | null> => {
    try {
      if (redis.status === "wait") await redis.connect();
      const raw = await redis.get(venueReportKey(d.bookId));
      const r = raw ? parseSignedVenueReport(raw) : null;
      if (!r || r.bookId !== d.bookId || r.chainId !== d.chainId || r.adapter.toLowerCase() !== d.adapter.toLowerCase()) return null;
      return r;
    } catch {
      return null;
    }
  };

  return {
    latest,
    async view() {
      const [r, at, exposure] = await Promise.all([latest(), read<bigint>("valuationAt"), read<bigint>("netExposureUsd")]);
      return freshestVenueView(r, at, exposure);
    },
    async relay() {
      try {
        const r = await latest();
        if (!r) return;
        if (r.asOf <= (await read<bigint>("valuationAt"))) return; // already as fresh on-chain
        const hash = await d.wallet.writeContract({
          address: d.adapter,
          abi: orderlyAdapterAbi,
          functionName: "reportSigned",
          args: [r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf, r.signature],
        } as never);
        await d.pub.waitForTransactionReceipt({ hash });
        d.log.info({ tx: hash, asOf: Number(r.asOf), netExposureUsd: r.netExposureUsd.toString() }, "signed venue report relayed before hedge leg");
      } catch (err) {
        const msg = (err as Error).message;
        // expected right after a capital flow (recall / fund): wait for ops-venue's next signed report
        if (msg.includes("ReportPredatesFlow")) d.log.info("venue report predates the last capital flow: waiting for the next signed report");
        else d.log.warn({ err: msg }, "venue report relay failed");
      }
    },
  };
}

/** The signed report when it is strictly newer than the on-chain valuation, else the on-chain view. */
export function freshestVenueView(
  r: Pick<SignedVenueReport, "asOf" | "netExposureUsd"> | null,
  onchainAt: bigint,
  onchainExposureUsd: bigint,
): { exposureUsd: bigint; valuationAt: number } {
  if (r && r.asOf > onchainAt) return { exposureUsd: r.netExposureUsd, valuationAt: Number(r.asOf) };
  return { exposureUsd: onchainExposureUsd, valuationAt: Number(onchainAt) };
}
