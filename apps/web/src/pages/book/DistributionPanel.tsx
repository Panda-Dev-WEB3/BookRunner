import { POLL, trpc } from "../../api/trpc";
import { EmptyState, Hash, Panel, QueryView, Table, Td, Th, ValueKind, cx } from "../../components/ui";
import { FEE_FLOW_LINE } from "../../lib/copy";
import { bpsPct, fmtDateTime, fmtUsd } from "../../lib/format";
import { type StepKey, distributionModel, frac, pickLastDistribution } from "../../lib/waterfall";

const BAR: Record<StepKey, string> = {
  gross: "bg-ink/80",
  expenses: "bg-muted",
  carry: "bg-backstop hatch",
  senior: "bg-senior",
  junior: "bg-junior",
};

export function DistributionPanel({ bookId }: { bookId: number }) {
  const q = trpc.settlements.list.useQuery({ bookId, limit: 50 }, { refetchInterval: POLL.marks });
  return (
    <Panel title="Fee-flow waterfall" meta="last distribution" actions={<ValueKind kind="marked" />}>
      <QueryView
        q={q}
        empty={(d) => !pickLastDistribution(d.items)}
        emptyView={<EmptyState compact title="No distribution yet" body="The router distributes fee flow once per mark period: expenses, then protocol carry, then the Senior share, then the Junior residual." />}
      >
        {(d) => {
          const last = pickLastDistribution(d.items);
          const model = last ? distributionModel(last) : null;
          if (!last || !model) return null;
          return (
            <>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-[11.5px] text-ink-2">
                <span>
                  {last.period != null && last.period > 1e9 ? (
                    <>
                      Period ending <span className="num">{fmtDateTime(last.period)}</span>
                    </>
                  ) : (
                    <>
                      Period <span className="num">{last.period ?? "n/a"}</span>
                    </>
                  )}{" "}
                  · distributed <span className="num">{fmtDateTime(last.ts)}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  tx <Hash value={last.txHash} kind="tx" />
                </span>
              </div>
              <ol className="space-y-2">
                {model.steps.map((s) => {
                  const left = frac(s.from, model.gross);
                  const width = frac(s.amount, model.gross);
                  return (
                    <li key={s.key} className="grid grid-cols-[96px_minmax(0,1fr)_92px] items-center gap-2 sm:grid-cols-[132px_minmax(0,1fr)_110px]">
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-medium">{s.label}</div>
                      </div>
                      <div className="relative h-5 rounded-[1px] bg-surface-2" title={s.note}>
                        <div
                          className={cx("absolute inset-y-0 rounded-[1px]", BAR[s.key])}
                          style={{ left: `${left * 100}%`, width: `${Math.max(width * 100, s.amount > 0n ? 0.6 : 0)}%` }}
                        />
                      </div>
                      <div className="num text-right text-[12.5px]">
                        {s.key === "gross" ? "" : "−"}
                        {fmtUsd(s.amount)}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[11.5px] text-ink-2 sm:grid-cols-3">
                <div>
                  Senior part of tranche credit <span className="num text-ink">{model.seniorShareBps === null ? "n/a" : bpsPct(model.seniorShareBps, 1)}</span>
                </div>
                <div>
                  Dust kept in the book <span className="num text-ink">{fmtUsd(model.dust, { dp: 6 })}</span>
                </div>
                <div className="col-span-2 sm:col-span-1">{model.conserved ? "Conserved: every unit is accounted for." : "Parts exceed gross: check the settlement row."}</div>
              </div>
              <p className="mt-2 text-[11px] text-muted">{FEE_FLOW_LINE}</p>
              {d.items.length > 1 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[12px] text-ink-2">All settlements ({d.items.length})</summary>
                  <div className="mt-2">
                    <Table minWidth={640}>
                      <thead>
                        <tr>
                          <Th>Time</Th>
                          <Th>Source</Th>
                          <Th right>Gross</Th>
                          <Th right>Expenses</Th>
                          <Th right>Carry</Th>
                          <Th right>Senior</Th>
                          <Th right>Junior</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.items.map((s) => (
                          <tr key={s.id}>
                            <Td num className="text-ink-2">
                              {fmtDateTime(s.ts)}
                            </Td>
                            <Td>{s.source.replace(/_/g, " ")}</Td>
                            <Td right num>
                              {fmtUsd(s.grossUsd)}
                            </Td>
                            <Td right num>
                              {fmtUsd(s.expensesUsd)}
                            </Td>
                            <Td right num>
                              {fmtUsd(s.carryUsd)}
                            </Td>
                            <Td right num>
                              {fmtUsd(s.seniorUsd)}
                            </Td>
                            <Td right num>
                              {fmtUsd(s.juniorUsd)}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </details>
              )}
            </>
          );
        }}
      </QueryView>
    </Panel>
  );
}
