import { useMemo } from "react";
import { POLL, trpc } from "../../api/trpc";
import { MiniLine } from "../../components/charts/MiniLine";
import { NavChart } from "../../components/charts/NavChart";
import { EmptyState, Legend, Panel, QueryView, ValueKind } from "../../components/ui";
import { fmtSharePrice } from "../../lib/format";
import { hasTrancheSplit, navSeries, sharePriceSeries } from "../../lib/nav";

export function NavPanel({ bookId }: { bookId: number }) {
  const q = trpc.book.nav.useQuery({ bookId, limit: 500 }, { refetchInterval: POLL.list });
  const series = useMemo(() => (q.data ? navSeries(q.data.points, q.data.live) : []), [q.data]);
  const marks = series.filter((p) => p.kind === "mark");
  const senior = sharePriceSeries(series, "senior");
  const junior = sharePriceSeries(series, "junior");
  const split = hasTrancheSplit(series);
  const hasLive = series.some((p) => p.kind === "live");

  return (
    <Panel
      title="NAV"
      meta={marks.length ? `${marks.length} mark${marks.length === 1 ? "" : "s"}` : undefined}
      actions={
        <div className="flex items-center gap-3">
          <ValueKind kind="marked" />
          {hasLive && <ValueKind kind="live" />}
        </div>
      }
    >
      <QueryView
        q={q}
        empty={(d) => d.points.length === 0 && !d.live}
        emptyView={
          <EmptyState
            title="No marks yet"
            body="NAV history starts at the first signed mark. Marks are committed once per mark period after the window closes and capital is deployed."
          />
        }
      >
        {() => (
          <>
            <Legend
              items={[
                ...(split
                  ? [
                      { label: "Senior NAV (base layer)", color: "var(--senior)" },
                      { label: "Junior NAV (first-loss layer)", color: "var(--junior)" },
                    ]
                  : [{ label: "Book NAV", color: "var(--accent)" }]),
                ...(hasLive ? [{ label: "Live estimate since the last mark", color: "var(--ink-2)", dashed: true }] : []),
              ]}
            />
            <div className="mt-2">
              <NavChart series={series} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["Senior NAV per share", senior, "var(--senior)"],
                  ["Junior NAV per share", junior, "var(--junior)"],
                ] as const
              ).map(([label, pts, color]) => {
                const first = pts[0];
                const last = pts[pts.length - 1];
                return (
                  <div key={label}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="eyebrow">{label}</span>
                      <span className="num text-[12px]">
                        {fmtSharePrice(last?.price ?? null)}
                        {first && last && first.markId !== last.markId && (
                          <span className="ml-2 text-muted">
                            {`from ${fmtSharePrice(first.price)} at mark #${first.markId}`}
                          </span>
                        )}
                      </span>
                    </div>
                    <MiniLine
                      data={pts.map((p) => ({ t: p.t, v: p.price }))}
                      color={color}
                      format={(v) => v.toFixed(5)}
                      ariaLabel={`${label} at each mark`}
                      emptyText="Share prices appear from the first mark"
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </QueryView>
    </Panel>
  );
}
