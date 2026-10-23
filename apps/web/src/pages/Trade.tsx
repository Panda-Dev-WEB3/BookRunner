// Trading (/trade, /trade/:marketId): single-stock perpetual markets on the in-house PoolEngine (Plan B2; docs/
// ARCHITECTURE.md §5 "Trading on the in-house engine"). The list shows the deployment's open engine markets, or "no
// market open yet"; a market page has the header (price and its age, session), the order, position and margin
// panels (every step prepared by the API, verified against the chain's PoolEngine and signed in the wallet), the
// contracts and the risks.
import { Link, useParams } from "react-router";
import { useQueryError } from "../api/hooks";
import { MarginPanel } from "../components/trade/MarginPanel";
import { OrderPanel } from "../components/trade/OrderPanel";
import { PositionPanel } from "../components/trade/PositionPanel";
import { EngineContract, MarketHeader, MarketList, TradeRisks } from "../components/trade/TradeBits";
import { useTradeMarket, useTradeMarkets, useTradePosition } from "../components/trade/useTrade";
import { Callout, EmptyState, ErrorState, Section, SkeletonRows, Term } from "../components/ui";
import { isTestChain } from "../wallet/network";
import { useWallet } from "../wallet/WalletContext";

function Lead() {
  return (
    <>
      Go long or short a single stock with a <Term id="perp">perpetual future</Term> on the protocol's own engine. The book's pool is the counterparty to every trade, each trade carries the latest
      signed oracle price, and your margin is isolated to the market.
    </>
  );
}

function NoMarket({ unsupported }: { unsupported: boolean }) {
  return unsupported ? (
    <EmptyState title="This API does not serve trading yet" body="The markets appear here once the API is updated." />
  ) : (
    <EmptyState
      title="No market open yet"
      body="In-house markets open once their book is chartered, funded and live. Until then nothing can be traded here."
      action={
        <Link className="btn" to="/books">
          See the books
        </Link>
      }
    />
  );
}

export function TradePage() {
  const markets = useTradeMarkets();
  const error = useQueryError(markets.q);
  const list = markets.data?.markets ?? [];
  return (
    <>
      <Section tone="hero" space="md" headingAs="h1" headerSize="lg" eyebrow="Trade" title="Single-stock perpetuals" lead={<Lead />}>
        {markets.supported === false ? (
          <NoMarket unsupported />
        ) : !markets.data ? (
          error ? (
            <ErrorState error={error} onRetry={() => void markets.q.refetch()} />
          ) : (
            <SkeletonRows rows={3} />
          )
        ) : list.length === 0 ? (
          markets.data.chainReadable ? (
            <NoMarket unsupported={false} />
          ) : (
            <Callout tone="warn" title="The chain could not be read just now">
              The open markets show again once it answers.
            </Callout>
          )
        ) : (
          <MarketList markets={list} />
        )}
      </Section>
      <Section id="risks" space="sm" eyebrow="Risks" title="Read this before you trade">
        <TradeRisks m={list[0] ?? null} />
      </Section>
    </>
  );
}

export function TradeMarketPage() {
  const params = useParams();
  const marketId = Number(params.marketId);
  const valid = Number.isInteger(marketId) && marketId > 0;
  const w = useWallet();
  const address = w.active?.address ?? null;
  const markets = useTradeMarkets();
  const supported = markets.supported === true;
  const market = useTradeMarket(marketId, supported && valid);
  const marketError = useQueryError(market);
  const position = useTradePosition(marketId, address, supported && valid && !!market.data);
  const positionError = useQueryError(position);
  const m = market.data;

  if (markets.supported === false) {
    return (
      <Section space="md" headingAs="h1" headerSize="md" eyebrow="Trade" title="Single-stock perpetuals">
        <NoMarket unsupported />
      </Section>
    );
  }
  if (!valid || (!m && marketError && /not found/i.test(String((marketError as Error).message ?? "")))) {
    return (
      <Section space="md" headingAs="h1" headerSize="md" eyebrow="Trade" title="Market not found">
        <EmptyState
          title={`There is no open in-house market #${params.marketId ?? ""}.`}
          action={
            <Link className="btn btn-primary" to="/trade">
              All markets
            </Link>
          }
        />
      </Section>
    );
  }
  if (!m) {
    return <Section space="md">{marketError ? <ErrorState error={marketError} onRetry={() => void market.refetch()} /> : <SkeletonRows rows={6} />}</Section>;
  }
  return (
    <>
      <Section tone="hero" space="sm" aria-label="Market">
        <div className="mb-3 text-[12.5px]">
          <Link className="link" to="/trade">
            All markets
          </Link>
        </div>
        <MarketHeader m={m} />
      </Section>
      <Section space="sm" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]" aria-label="Trade">
        <div className="min-w-0 space-y-6">
          <OrderPanel m={m} address={address} position={position.data} />
          {address && <PositionPanel m={m} address={address} position={position.data} error={positionError} onRetry={() => void position.refetch()} />}
        </div>
        <div className="min-w-0 space-y-6">
          <MarginPanel m={m} address={address} position={position.data} />
          <EngineContract m={m} />
          <p className="text-[12px] text-ink-2">
            {isTestChain
              ? "This is a test network: its settlement token has no value. Every step opens in your wallet first; check it before you confirm."
              : "Perpetuals are leveraged: you can lose all of the margin in this market. Every step opens in your wallet first; check it before you confirm."}
          </p>
        </div>
      </Section>
      <Section id="risks" tone="muted" space="sm" eyebrow="Risks" title="Read this before you trade">
        <TradeRisks m={m} />
      </Section>
    </>
  );
}
