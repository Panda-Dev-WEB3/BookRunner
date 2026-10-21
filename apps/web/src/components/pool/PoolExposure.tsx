// Exposure per market (underlying): what the pool lent to the books on it against the per-market cap, what it has
// marked down, and each book's position (allocation, what it can repay, losses split first-loss / depositors).
import { Link } from "react-router";
import type { PoolExposureOut } from "../../lib/api-types";
import { bpsPct, fmtDateTime, fmtUsd, usdRaw } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { Card, Chip, EmptyState, ErrorState, ProgressBar, SkeletonRows, Table, Td, Th } from "../ui";
import { DEFAULT_MARKET_CAP_BPS, capFill, capTone } from "./poolLogic";

export function PoolExposure(props: { data: PoolExposureOut | undefined; error: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const d = props.data;
  if (!d) return props.error ? <ErrorState compact error={props.error} onRetry={props.onRetry} /> : <SkeletonRows rows={4} />;
  if (d.markets.length === 0) return <EmptyState compact title="No book draws on the pool yet" body="A pool-funded book draws its insurance fund from the pool when its subscription window closes." />;
  const capPct = bpsPct(d.marketCapBps ?? DEFAULT_MARKET_CAP_BPS);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {d.markets.map((m) => {
        const fill = capFill(m.capUsedBps);
        const tone = capTone(m.capUsedBps);
        const shortfall = usdRaw(m.shortfallUsd) ?? 0n;
        return (
          <Card
            key={m.market}
            title={m.label}
            actions={shortfall > 0n ? <Chip tone="critical">Marked down</Chip> : <Chip tone="good">Fully repayable</Chip>}
            padding="md"
          >
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-ink-2">Lent to books on this market</span>
              <span className="num font-medium">
                {fmtUsd(m.allocatedUsd)} {sym}
                {m.capUsd ? <span className="text-ink-2"> of {fmtUsd(m.capUsd, { compact: true })} cap</span> : null}
              </span>
            </div>
            <ProgressBar className="mt-2" size="md" value={fill ?? 0} tone={tone === "critical" ? "critical" : tone === "warn" ? "warn" : "accent"} label={`Share of the ${capPct} market cap in use`} />
            <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[11.5px] text-muted">
              <span>{fill === null ? "Cap unknown while the chain is unreachable" : `${bpsPct(m.capUsedBps ?? 0, 1)} of the cap (${capPct} of the pool per market)`}</span>
              <span>{m.shareOfPoolBps === null ? "" : `${bpsPct(m.shareOfPoolBps, 1)} of the pool`}</span>
            </div>
            {shortfall > 0n && (
              <p className="mt-2 text-[12px] text-critical-ink">
                {fmtUsd(m.shortfallUsd)} {sym} marked down: at their last marks the books on this market could not repay that much of their insurance fund.
              </p>
            )}
            <div className="mt-3">
              <Table minWidth={520}>
                <thead>
                  <tr>
                    <Th>Book</Th>
                    <Th right>Lent</Th>
                    <Th right>Repayable</Th>
                    <Th right>Losses</Th>
                    <Th right>Premiums</Th>
                    <Th>Last mark</Th>
                  </tr>
                </thead>
                <tbody>
                  {m.books.map((b) => {
                    const loss = (usdRaw(b.lossFirstLossUsd) ?? 0n) + (usdRaw(b.lossDepositorsUsd) ?? 0n);
                    return (
                      <tr key={b.bookId}>
                        <Td>
                          <Link className="link" to={`/books/${b.bookId}`}>
                            {b.name ?? b.symbol ?? `Book #${b.bookId}`}
                          </Link>
                          {!b.active && <span className="ml-1.5 text-[11px] text-muted">retired</span>}
                        </Td>
                        <Td right num>
                          {fmtUsd(b.allocationUsd, { compact: true })}
                        </Td>
                        <Td right num>
                          {fmtUsd(b.claimUsd, { compact: true })}
                        </Td>
                        <Td right num title={loss > 0n ? `First-loss slice ${fmtUsd(b.lossFirstLossUsd)} · depositors ${fmtUsd(b.lossDepositorsUsd)}` : undefined}>
                          {fmtUsd(loss, { compact: true })}
                        </Td>
                        <Td right num>
                          {fmtUsd(b.premiumsUsd, { compact: true })}
                        </Td>
                        <Td num className="text-ink-2">
                          {fmtDateTime(b.lastMarkAt)}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
