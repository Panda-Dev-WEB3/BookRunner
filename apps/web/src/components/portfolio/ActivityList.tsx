// Recent activity of the wallet across every book: deposits, allocation claims, redemption requests
// and redemption claims, each with an explorer link. Read from the tranche contracts' event logs; if
// the RPC refuses the log query, falls back to the redemption requests the API lists.
import type { Address } from "viem";
import type { BookListItem } from "../../lib/api-types";
import { addressUrl } from "../../lib/config";
import { fmtWhen, tickerOf } from "../../lib/format";
import type { BookContracts } from "../../wallet/contracts";
import { cx } from "../cx";
import { Card, EmptyState, ExternalLink, Hash, SkeletonRows, TrancheBadge } from "../ui";
import { ACTIVITY_LABEL, shares, usd } from "./display";
import { useWalletActivity } from "./hooks";
import { type ActivityItem, type ActivityKind, type BookHolding, activityFromRedemptions } from "./model";

const KIND_DOT: Record<ActivityKind, string> = {
  deposit: "bg-accent",
  allocation: "bg-good",
  refund: "bg-good",
  redeemRequest: "bg-warn",
  redemptionClaim: "bg-good",
};

function Row({ item, ticker }: { item: ActivityItem; ticker: string }) {
  const amount = item.unit === "USDC" ? usd(item.amount) : shares(item.amount);
  return (
    <li className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", KIND_DOT[item.kind])} aria-hidden />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-ink">{ACTIVITY_LABEL[item.kind]}</span>
            <span className="text-[12.5px] text-ink-2">{ticker}</span>
            <TrancheBadge tranche={item.tranche} size="sm" />
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{item.timestamp ? fmtWhen(item.timestamp) : item.blockNumber !== null ? `Block ${item.blockNumber.toString()}` : "Time unknown"}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5 sm:pl-0 sm:text-right">
        <span className="num text-[13.5px] font-medium text-ink">
          {amount}
          {item.refund !== null && item.refund > 0n && <span className="text-[12px] text-ink-2"> + {usd(item.refund)} refund</span>}
        </span>
        {item.txHash && <Hash value={item.txHash} kind="tx" />}
      </div>
    </li>
  );
}

export function ActivityList(props: { wallet: Address; books: BookListItem[]; contracts: BookContracts[]; holdings: BookHolding[] }) {
  const q = useWalletActivity(props.wallet, props.contracts);
  const tickers = new Map(props.books.map((b) => [b.bookId, tickerOf(b.symbol)]));
  const fallback = q.isError && !q.data;
  const items = q.data ?? (fallback ? activityFromRedemptions(props.holdings, 15) : null);
  const explorer = addressUrl(props.wallet);
  return (
    <Card padding="md" as="div">
      {items === null ? (
        <SkeletonRows rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          compact
          title="No activity yet"
          body={fallback ? "The network did not answer the activity query, and the API lists no redemption requests for this wallet." : "Deposits, claims and redemption requests from this wallet show up here once they are on-chain."}
        />
      ) : (
        <>
          {fallback && (
            <p className="mb-2 text-[12px] text-warn-ink" role="status">
              The network did not answer the full activity query, so only redemption requests (from the Bookrunner API) are listed.
            </p>
          )}
          <ul className="-my-1 divide-y divide-line">
            {items.map((i) => (
              <Row key={i.id} item={i} ticker={tickers.get(i.bookId) ?? `Book ${i.bookId}`} />
            ))}
          </ul>
        </>
      )}
      {explorer && (
        <div className="mt-3 border-t border-line pt-3 text-[12.5px]">
          <ExternalLink href={explorer}>Full history on the block explorer</ExternalLink>
        </div>
      )}
    </Card>
  );
}
