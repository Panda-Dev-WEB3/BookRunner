import { useState } from "react";
import { POLL, trpc } from "../../api/trpc";
import { EmptyState, Hash, Panel, QueryView, Table, Td, Th, ValueKind, cx } from "../../components/ui";
import type { MarkItem } from "../../lib/api-types";
import { fmtDateTime, fmtSharePrice, fmtUsd, isZeroHash } from "../../lib/format";

export function useBookMarks(bookId: number) {
  return trpc.book.marks.useQuery({ bookId, limit: 50 }, { refetchInterval: POLL.marks });
}

const PAGE = 12;

export function MarksPanel(props: { bookId: number; selected: number | null; onSelect: (m: MarkItem) => void }) {
  const q = useBookMarks(props.bookId);
  const [n, setN] = useState(PAGE);
  return (
    <Panel title="Marks" meta="signed EIP-712, committed on-chain" actions={<ValueKind kind="marked" />}>
      <QueryView
        q={q}
        empty={(d) => d.items.length === 0}
        emptyView={<EmptyState compact title="No marks committed yet" body="The mark service commits one mark per period: NAV, inventory root, receipts root and the PnL statement hash, signed and applied to the book." />}
      >
        {(d) => (
          <>
          <Table minWidth={1080}>
            <thead>
              <tr>
                <Th>Mark</Th>
                <Th>Period end</Th>
                <Th right>NAV</Th>
                <Th right>Senior / sh</Th>
                <Th right>Junior / sh</Th>
                <Th right>Mark PnL</Th>
                <Th>Receipts root</Th>
                <Th>Inventory root</Th>
                <Th>Commit tx</Th>
                <Th>Applied</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {d.items.slice(0, n).map((m) => (
                <tr key={m.markId} className={cx(props.selected === m.markId && "bg-accent-soft")}>
                  <Td num className="font-medium">
                    #{m.markId}
                  </Td>
                  <Td num className="text-ink-2">
                    {fmtDateTime(m.periodEndAt)}
                  </Td>
                  <Td right num>
                    {fmtUsd(m.navUsd)}
                  </Td>
                  <Td right num>
                    {fmtSharePrice(m.seniorSharePrice)}
                  </Td>
                  <Td right num>
                    {fmtSharePrice(m.juniorSharePrice)}
                  </Td>
                  <Td right num className={m.pnlUsd?.startsWith("-") ? "text-critical-ink" : undefined}>
                    {m.pnlUsd ? fmtUsd(m.pnlUsd, { signed: true }) : "—"}
                  </Td>
                  <Td>{isZeroHash(m.receiptsRoot) ? <span className="text-[11.5px] text-muted">empty period</span> : <Hash value={m.receiptsRoot} />}</Td>
                  <Td>
                    <Hash value={m.inventoryRoot} />
                  </Td>
                  <Td>
                    <Hash value={m.txHash} kind="tx" />
                  </Td>
                  <Td>{m.appliedTx ? <Hash value={m.appliedTx} kind="tx" /> : <span className="text-[11.5px] text-warn-ink">pending</span>}</Td>
                  <Td right>
                    <button type="button" className="btn h-7 min-h-7 px-2 text-[12px]" onClick={() => props.onSelect(m)}>
                      Verify proof
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {n < d.items.length && (
            <div className="mt-2 flex justify-center">
              <button type="button" className="btn h-7 min-h-7 text-[12px]" onClick={() => setN((x) => x + PAGE)}>
                Show {Math.min(PAGE, d.items.length - n)} more of {d.items.length - n}
              </button>
            </div>
          )}
          </>
        )}
      </QueryView>
    </Panel>
  );
}
