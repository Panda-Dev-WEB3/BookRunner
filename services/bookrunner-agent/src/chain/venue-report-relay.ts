// Low-gas mode (docs/LOW_GAS.md §2): ops-venue signs Orderly venue reports off-chain and the adapter's
// on-chain valuation only advances at marks. A risk-adding hedge on an Orderly book needs a fresh report
// (MMMandate: valuationAt within 4 x maxPriceAge), so the agent relays the latest signed report with
// OrderlyAdapter.reportSigned right before such a leg. Best-effort: a failed relay never blocks the hedge
// attempt (the mandate then refuses the leg exactly as before).
import { orderlyAdapterAbi } from "@bookrunner/shared/abi";
import type { Logger } from "@bookrunner/shared";
import { Redis } from "ioredis";
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import { parseSignedVenueReport, venueReportKey } from "../../../ops-venue/src/report712";

export interface VenueReportRelayDeps {
  redisUrl: string;
  bookId: number;
  adapter: Address;
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  log: Logger;
}

export function makeVenueReportRelay(d: VenueReportRelayDeps): () => Promise<void> {
  const redis = new Redis(d.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  return async () => {
    try {
      if (redis.status === "wait") await redis.connect();
      const raw = await redis.get(venueReportKey(d.bookId));
      const r = raw ? parseSignedVenueReport(JSON.parse(raw)) : null;
      if (!r) return;
      const onchain = (await d.pub.readContract({ address: d.adapter, abi: orderlyAdapterAbi, functionName: "valuationAt" })) as bigint;
      if (BigInt(r.asOf) <= onchain) return; // already as fresh on-chain
      const hash = await d.wallet.writeContract({
        address: d.adapter,
        abi: orderlyAdapterAbi,
        functionName: "reportSigned",
        args: [r.insuranceUsd, r.marginUsd, r.netExposureUsd, BigInt(r.asOf), r.signature],
      } as never);
      await d.pub.waitForTransactionReceipt({ hash });
      d.log.info({ tx: hash, asOf: Number(r.asOf) }, "signed venue report relayed before hedge");
    } catch (err) {
      d.log.debug({ err: (err as Error).message }, "venue report relay skipped");
    }
  };
}
