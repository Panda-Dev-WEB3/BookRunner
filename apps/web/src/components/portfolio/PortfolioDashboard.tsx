// The connected portfolio: overview and wallet, claims waiting, one card per book held, BKRN staking,
// how values are worked out, and recent activity.
import { useState } from "react";
import { Link } from "react-router";
import type { Address } from "viem";
import { useNow } from "../../api/hooks";
import { tickerOf } from "../../lib/format";
import { useAppContracts } from "../../wallet/contracts";
import { isTestChain } from "../../wallet/network";
import { IconArrowRight } from "../icons";
import { SetupChecklist } from "../SetupChecklist";
import { Term } from "../Term";
import { Callout, Card, EmptyState, ErrorState, Section, SkeletonRows } from "../ui";
import { ActivityList } from "./ActivityList";
import { BookPositionCard } from "./BookPositionCard";
import { ClaimModal } from "./ClaimModal";
import { PORTFOLIO_LEAD, usd } from "./display";
import { usePortfolio } from "./hooks";
import { type TrancheName, markTimes } from "./model";
import { Overview, type OverviewState } from "./Overview";
import { PositionLifecycle } from "./PositionLifecycle";
import { RedeemModal } from "./RedeemModal";
import { StakingSummary } from "./StakingSummary";
import { WalletCard } from "./WalletCard";

function ValuationNotes({ cadence }: { cadence: string | null }) {
  return (
    <Card as="aside" aria-label="How values are worked out" title="How these numbers are worked out">
      <ul className="space-y-3 text-[13px] text-ink-2">
        <li>
          <span className="font-medium text-ink">Value</span> is your shares times the share price of each book's latest <Term id="mark">mark</Term>, the signed statement committed on-chain every period
          {cadence ? ` (${cadence} here)` : ""}. It is not a live estimate.
        </li>
        <li>
          <span className="font-medium text-ink">No profit or loss figure.</span> Bookrunner does not record what you paid for your shares, so this page shows value only.
        </li>
        <li>
          <span className="font-medium text-ink">Values can fall.</span> Losses hit <Term id="junior">Junior</Term> first, then <Term id="senior">Senior</Term>, then the <Term id="backstop">backstop</Term> up to what its pool holds.
        </li>
        {isTestChain && (
          <li>
            <span className="font-medium text-ink">Testnet.</span> Test USDC and test ETH have no value, and nothing here is an offer.
          </li>
        )}
      </ul>
    </Card>
  );
}

export function PortfolioDashboard({ wallet }: { wallet: Address }) {
  const p = usePortfolio(wallet);
  const contracts = useAppContracts();
  const now = useNow(30_000);
  const [claimBook, setClaimBook] = useState<number | null>(null);
  const [redeem, setRedeem] = useState<{ bookId: number; tranche: TrancheName } | null>(null);

  const books = p.booksQuery.data ?? [];
  const held = p.entries.filter((e) => e.holding?.hasPosition);
  const hasPosition = held.length > 0;
  const marks = markTimes(books, (hasPosition ? held : p.entries).map((e) => e.book.bookId));
  const claimable = held.filter((e) => e.holding?.canClaim);
  const tickerFor = (id: number | null) => {
    const b = books.find((x) => x.bookId === id);
    return b ? tickerOf(b.symbol) : `#${id ?? ""}`;
  };
  const redeemHolding = redeem ? (p.entries.find((e) => e.book.bookId === redeem.bookId)?.holding?.tranches.find((t) => t.tranche === redeem.tranche) ?? null) : null;
  const booksError = p.booksQuery.error && !p.booksQuery.data ? p.booksQuery.error : null;
  const stillLoading = p.loading && !hasPosition;
  // Every book failed to load: nothing can be said about this wallet yet (never show "no positions").
  const unknown = booksError !== null || (p.holdings.length === 0 && p.failed.length > 0);
  // Some books failed and none of the others has a position: "no positions" cannot be claimed either.
  const cantTell = unknown || (!hasPosition && p.failed.length > 0);
  const overviewState: OverviewState = unknown ? "unknown" : p.loading && p.holdings.length === 0 ? "loading" : "ready";

  return (
    <>
      <Section
        tone="hero"
        space="sm"
        headingAs="h1"
        headerSize="md"
        eyebrow="Portfolio"
        title="Your portfolio"
        lead={PORTFOLIO_LEAD}
        actions={
          <Link className="btn btn-primary" to="/invest">
            {hasPosition ? "Invest more" : "Explore books"}
            <IconArrowRight size={14} />
          </Link>
        }
      >
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
          <Overview totals={p.totals} marks={marks} state={overviewState} failedBooks={booksError ? 0 : p.failed.length} />
          <WalletCard />
        </div>
        {claimable.length > 0 && (
          <Callout
            tone="success"
            className="mt-4"
            title="You have something to claim"
            action={claimable.map((e) => (
              <button key={e.book.bookId} type="button" className="btn btn-primary btn-sm" onClick={() => setClaimBook(e.book.bookId)}>
                Claim from {tickerOf(e.book.symbol)}
                {e.holding && e.holding.claimableUsd > 0n && <span className="num font-normal opacity-90">{usd(e.holding.claimableUsd)}</span>}
              </button>
            ))}
          >
            Shares from a settled round, refunds or USDC from settled redemptions are waiting. Claiming sends them to your wallet.
          </Callout>
        )}
      </Section>

      <Section space="sm" title="Positions" headerSize="sm" lead="One card per book. Each book is marked on its own schedule, so each card shows the mark it is valued at.">
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            {booksError ? (
              <ErrorState error={booksError} onRetry={p.refetch} />
            ) : stillLoading ? (
              <Card>
                <SkeletonRows rows={5} />
              </Card>
            ) : hasPosition ? (
              held.map((e) =>
                e.holding ? (
                  <BookPositionCard
                    key={e.book.bookId}
                    book={e.book}
                    holding={e.holding}
                    round={p.rounds?.[e.book.bookId]}
                    nowMs={now}
                    onClaim={() => setClaimBook(e.book.bookId)}
                    onRedeem={(tranche) => setRedeem({ bookId: e.book.bookId, tranche })}
                  />
                ) : null,
              )
            ) : cantTell ? (
              <ErrorState error={p.failed[0]?.error} onRetry={p.refetch} />
            ) : (
              <>
                <EmptyState
                  title="No positions yet"
                  body="This wallet holds no Senior or Junior shares, has no deposits waiting and nothing to claim. Pick a book and a tranche to make a first deposit: it waits in escrow until a mark accepts it."
                  action={
                    <Link className="btn btn-primary mt-2" to="/invest">
                      Explore books
                      <IconArrowRight size={14} />
                    </Link>
                  }
                />
                <div className="pt-2">
                  <h3 className="mb-3 text-[14px] font-semibold text-ink">What happens after you deposit</h3>
                  <PositionLifecycle compact />
                </div>
              </>
            )}
            {hasPosition && p.failed.length > 0 && <ErrorState compact error={p.failed[0]?.error} onRetry={p.refetch} />}
          </div>
          <div className="min-w-0 space-y-4">
            {/* setup steps matter before a first deposit; afterwards the wallet card flags low gas */}
            {!hasPosition && !stillLoading && !cantTell && <SetupChecklist whenReady="hide" compact title="Finish setting up" />}
            <StakingSummary wallet={wallet} />
            <ValuationNotes cadence={books[0]?.markSchedule?.cadence ?? null} />
          </div>
        </div>
      </Section>

      <Section tone="muted" space="sm" title="Recent activity" headerSize="sm" lead="This wallet's deposits, claims and redemption requests across every book, newest first.">
        <ActivityList wallet={wallet} books={books} contracts={contracts.books} holdings={p.holdings} />
      </Section>

      <ClaimModal open={claimBook !== null} onClose={() => setClaimBook(null)} bookId={claimBook} ticker={tickerFor(claimBook)} wallet={wallet} />
      {redeem && (
        <RedeemModal open onClose={() => setRedeem(null)} bookId={redeem.bookId} ticker={tickerFor(redeem.bookId)} holding={redeemHolding} wallet={wallet} />
      )}
    </>
  );
}
