// Fills and hedges. Row feeds come from book.fills / book.hedges. When the API does not serve them
// (an older version) or the feed request fails, each tab falls back to the venue / desk state signed
// into every mark's PnL statement (the same data the mark commits to), so the panel always shows
// real, verifiable activity.
import { useMemo, useState } from "react";
import { useOptional, useQueryError } from "../../api/hooks";
import { POLL } from "../../api/trpc";
import { EmptyState, Hash, Panel, Segmented, SkeletonRows, Table, Td, Th, ValueKind } from "../../components/ui";
import type { MarkItem } from "../../lib/api-types";
import { hedgeQty, parseFills, parseHedges } from "../../lib/feeds";
import { DASH, fmtDateTime, fmtNum, fmtPrice, fmtTime, fmtUsd, fmtUsdFloat, shortHex } from "../../lib/format";
import { type MarkStatement, markStatements, wadToNumber } from "../../lib/markStatement";

const PAGE = 12;

function More({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="mt-2 flex justify-center">
      <button type="button" className="btn h-7 min-h-7 text-[12px]" onClick={onMore}>
        Show {Math.min(PAGE, total - shown)} more of {total - shown}
      </button>
    </div>
  );
}

function FallbackNote({ what, failed, onRetry }: { what: string; failed: boolean; onRetry: () => void }) {
  const instead = `showing the ${what === "fills" ? "venue" : "desk"} state signed into each mark's PnL statement instead.`;
  return (
    <p className="mb-2 text-[11.5px] text-muted">
      {failed ? `The ${what} feed could not be loaded; ${instead}` : `This API version does not serve the ${what} feed yet; ${instead}`} Every fill and hedge is still a
      receipt leaf, verifiable below.
      {failed && (
        <>
          {" "}
          <button type="button" className="link" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </p>
  );
}

function VenueByMark({ rows }: { rows: MarkStatement[] }) {
  const [n, setN] = useState(PAGE);
  if (rows.length === 0) return <EmptyState compact title="No marks yet" body="Venue state is signed into every mark once the book is live." />;
  return (
    <>
      <Table minWidth={820}>
        <thead>
          <tr>
            <Th>Mark</Th>
            <Th>Period end</Th>
            <Th right title="Signed: + long, - short (book's venue position)">
              Net exposure
            </Th>
            <Th right>Margin</Th>
            <Th right>Insurance fund</Th>
            <Th right>Fee flow</Th>
            <Th right>Realised</Th>
            <Th right>Unrealised</Th>
            <Th right>Mark PnL</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, n).map((s) => (
            <tr key={s.markId}>
              <Td num className="font-medium">
                #{s.markId}
              </Td>
              <Td num className="text-ink-2">
                {fmtDateTime(s.periodEndAt)}
              </Td>
              <Td right num>
                {fmtUsd(s.venue.netExposureUsd, { signed: true })}
              </Td>
              <Td right num>
                {fmtUsd(s.venue.marginUsd)}
              </Td>
              <Td right num>
                {fmtUsd(s.venue.insuranceUsd)}
              </Td>
              <Td right num>
                {fmtUsd(s.pnl.feeFlowUsd)}
              </Td>
              <Td right num>
                {fmtUsd(s.pnl.realizedUsd, { signed: true })}
              </Td>
              <Td right num>
                {fmtUsd(s.pnl.unrealizedUsd, { signed: true })}
              </Td>
              <Td right num className={s.pnl.markPnlUsd?.startsWith("-") ? "text-critical-ink" : undefined}>
                {fmtUsd(s.pnl.markPnlUsd, { signed: true })}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <More shown={n} total={rows.length} onMore={() => setN((x) => x + PAGE)} />
    </>
  );
}

function DeskByMark({ rows }: { rows: MarkStatement[] }) {
  const [n, setN] = useState(PAGE);
  if (rows.length === 0) return <EmptyState compact title="No marks yet" body="The desk hedge book is signed into every mark once the book is live." />;
  return (
    <>
      <Table minWidth={760}>
        <thead>
          <tr>
            <Th>Mark</Th>
            <Th>Period end</Th>
            <Th right>Hedge value</Th>
            <Th right>Desk USDC</Th>
            <Th right>Hedge ratio</Th>
            <Th>Positions (token · qty · price)</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, n).map((s) => (
            <tr key={s.markId}>
              <Td num className="font-medium">
                #{s.markId}
              </Td>
              <Td num className="text-ink-2">
                {fmtDateTime(s.periodEndAt)}
              </Td>
              <Td right num>
                {fmtUsd(s.desk.hedgeValueUsd)}
              </Td>
              <Td right num>
                {fmtUsd(s.desk.usdc)}
              </Td>
              <Td right num>
                {s.hedgeRatioBps === null ? DASH : `${(s.hedgeRatioBps / 100).toFixed(0)}%`}
              </Td>
              <Td className="text-ink-2">
                {s.desk.positions.length === 0 ? (
                  <span className="text-muted">no spot hedges held</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {s.desk.positions.map((p) => (
                      <span key={p.token} className="num inline-flex items-center gap-2 text-[11.5px]">
                        <Hash value={p.token} kind="address" />
                        <span>{fmtNum(hedgeQty(p.qtyRaw), 4)}</span>
                        <span className="text-muted">@ {fmtPrice(wadToNumber(p.priceWad))}</span>
                      </span>
                    ))}
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <More shown={n} total={rows.length} onMore={() => setN((x) => x + PAGE)} />
    </>
  );
}

export function ActivityPanel({ bookId, marks, onVerify }: { bookId: number; marks: MarkItem[]; onVerify: (receiptId: number) => void }) {
  const [tab, setTab] = useState<"fills" | "hedges">("fills");
  const [n, setN] = useState(PAGE);
  const fills = useOptional("book.fills", { bookId, limit: 100 }, parseFills, { refetchInterval: POLL.live, enabled: tab === "fills" });
  const hedges = useOptional("book.hedges", { bookId, limit: 100 }, parseHedges, { refetchInterval: POLL.list, enabled: tab === "hedges" });
  const statements = useMemo(() => markStatements(marks), [marks]);
  const q = tab === "fills" ? fills : hedges;
  const error = useQueryError(q);
  // a failed feed (no rows yet) degrades to the signed per-mark view instead of an error box
  const failed = q.data === undefined && error != null;
  const fallback = q.data?.supported === false || failed;

  return (
    <Panel
      title="Fills & hedges"
      meta={fallback ? "per mark, from the signed PnL statement" : undefined}
      actions={
        <div className="flex items-center gap-2">
          {fallback ? <ValueKind kind="marked" /> : <ValueKind kind="live" />}
          <Segmented
            size="sm"
            value={tab}
            onChange={(t) => (setTab(t), setN(PAGE))}
            ariaLabel="Activity feed"
            options={[
              { value: "fills", label: "Fills" },
              { value: "hedges", label: "Hedges" },
            ]}
          />
        </div>
      }
    >
      {q.data === undefined && !failed ? (
        <SkeletonRows rows={3} />
      ) : fallback ? (
        <>
          <FallbackNote what={tab} failed={failed} onRetry={() => q.refetch()} />
          {tab === "fills" ? <VenueByMark rows={statements} /> : <DeskByMark rows={statements} />}
        </>
      ) : tab === "fills" ? (
        fills.data && fills.data.data.length === 0 ? (
          <EmptyState compact title="No fills yet" body="Taker flow that crosses the book's quotes appears here, newest first." />
        ) : (
          <>
            <Table minWidth={620}>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Side</Th>
                  <Th right>Qty</Th>
                  <Th right>Price</Th>
                  <Th right>Notional</Th>
                  <Th right>Fee</Th>
                  <Th>Trade</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {(fills.data?.data ?? []).slice(0, n).map((f, i) => (
                  <tr key={`${f.venueTradeId}-${i}`}>
                    <Td num className="text-ink-2">
                      {fmtTime(f.ts)}
                    </Td>
                    <Td>
                      <span className={f.side === "buy" ? "text-good-ink" : "text-critical-ink"}>{f.side === "buy" ? "Book buys" : "Book sells"}</span>
                      <span className="ml-1.5 text-[10.5px] text-muted">{f.maker ? "maker" : "taker"}</span>
                    </Td>
                    <Td right num>
                      {fmtNum(f.qty, 4)}
                    </Td>
                    <Td right num>
                      {fmtPrice(f.px)}
                    </Td>
                    <Td right num>
                      {fmtUsdFloat(f.qty * f.px)}
                    </Td>
                    <Td right num>
                      {fmtUsdFloat(f.feeUsd)}
                    </Td>
                    <Td num className="text-ink-2" title={f.venueTradeId}>
                      {shortHex(f.venueTradeId, 8, 4)}
                    </Td>
                    <Td right>
                      {f.receiptId !== null && (
                        <button type="button" className="link text-[11.5px]" onClick={() => onVerify(f.receiptId as number)}>
                          Verify
                        </button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <More shown={n} total={fills.data?.data.length ?? 0} onMore={() => setN((x) => x + PAGE)} />
          </>
        )
      ) : hedges.data && hedges.data.data.length === 0 ? (
        <EmptyState compact title="No hedges yet" body="Desk hedges keep the hedge ratio inside the mandate band (long spot Stock Tokens offset short venue exposure)." />
      ) : (
        <>
          <Table minWidth={640}>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Asset</Th>
                <Th>Venue</Th>
                <Th right title="Signed: + buy, - sell (whole tokens)">
                  Qty
                </Th>
                <Th right>Price</Th>
                <Th right>Value</Th>
                <Th>Tx</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(hedges.data?.data ?? []).slice(0, n).map((h, i) => (
                <tr key={h.id ?? i}>
                  <Td num className="text-ink-2">
                    {fmtTime(h.ts)}
                  </Td>
                  <Td>
                    <Hash value={h.asset} kind="address" />
                  </Td>
                  <Td>{h.venue}</Td>
                  <Td right num className={h.qtyRaw.startsWith("-") ? "text-critical-ink" : "text-good-ink"}>
                    {h.qtyRaw.startsWith("-") ? "" : "+"}
                    {fmtNum(hedgeQty(h.qtyRaw), 4)}
                  </Td>
                  <Td right num>
                    {fmtPrice(h.px)}
                  </Td>
                  <Td right num>
                    {h.valueUsd ? fmtUsd(h.valueUsd) : DASH}
                  </Td>
                  <Td>
                    <Hash value={h.txHash} kind="tx" />
                  </Td>
                  <Td right>
                    {h.receiptId !== null && (
                      <button type="button" className="link text-[11.5px]" onClick={() => onVerify(h.receiptId as number)}>
                        Verify
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <More shown={n} total={hedges.data?.data.length ?? 0} onMore={() => setN((x) => x + PAGE)} />
        </>
      )}
    </Panel>
  );
}
