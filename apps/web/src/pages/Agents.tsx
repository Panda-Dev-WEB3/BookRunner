import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useNow } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { Chip, EmptyState, ErrorState, Field, Hash, PageHeader, Panel, QueryView, Segmented, Table, Td, Th } from "../components/ui";
import type { AgentKey } from "../lib/api-types";
import { AGENTS_LINE } from "../lib/copy";
import { DASH, ageMs, fmtAgo, fmtDateTime, fmtUsd, tickerOf } from "../lib/format";
import { TxRunner } from "../wallet/TxRunner";
import { WalletButton } from "../wallet/WalletButton";
import { useWallet } from "../wallet/WalletContext";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const USD = /^\d+(\.\d{1,6})?$/;

function defaultValidUntil(): string {
  const d = new Date(Date.now() + 30 * 86_400_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RegisterForm({ bookId, maxInventoryUsd }: { bookId: number; maxInventoryUsd: string | null }) {
  const w = useWallet();
  const utils = trpc.useUtils();
  const reg = trpc.agent.register.useMutation();
  const [key, setKey] = useState("");
  const [operator, setOperator] = useState("");
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const [tier, setTier] = useState(maxInventoryUsd ? String(Number(maxInventoryUsd)) : "");
  useEffect(() => {
    if (maxInventoryUsd && !tier) setTier(String(Number(maxInventoryUsd)));
  }, [maxInventoryUsd, tier]);
  const keyOk = ADDR.test(key.trim());
  const opOk = ADDR.test(operator.trim());
  const tierOk = USD.test(tier.trim());
  const untilMs = Date.parse(validUntil);
  const untilOk = Number.isFinite(untilMs) && untilMs > Date.now();
  const ok = keyOk && opOk && tierOk && untilOk;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Desk session key" help="Address of the agent's session key" error={key && !keyOk ? "Enter a 0x address" : null} htmlFor="reg-key">
          <input id="reg-key" className="field num" value={key} onChange={(e) => (setKey(e.currentTarget.value.trim()), reg.reset())} placeholder="0x…" />
        </Field>
        <Field label="Operator" help="Stakes BKRN for the inventory tier bond" error={operator && !opOk ? "Enter a 0x address" : null} htmlFor="reg-op">
          <input id="reg-op" className="field num" value={operator} onChange={(e) => (setOperator(e.currentTarget.value.trim()), reg.reset())} placeholder="0x…" />
        </Field>
        <Field label="Inventory tier (USD)" help={maxInventoryUsd ? `Must be at least the mandate's max inventory, ${fmtUsd(maxInventoryUsd)}` : "Must cover the mandate's max inventory"} error={tier && !tierOk ? "Enter a USD amount" : null} htmlFor="reg-tier">
          <input id="reg-tier" className="field num" inputMode="decimal" value={tier} onChange={(e) => (setTier(e.currentTarget.value.replace(/[^\d.]/g, "")), reg.reset())} />
        </Field>
        <Field label="Valid until" error={validUntil && !untilOk ? "Must be in the future" : null} htmlFor="reg-until">
          <input id="reg-until" type="datetime-local" className="field num" value={validUntil} onChange={(e) => (setValidUntil(e.currentTarget.value), reg.reset())} />
        </Field>
      </div>
      {w.active ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ok || reg.isPending}
          onClick={() => reg.mutate({ bookId, key: key.trim(), operator: operator.trim(), validUntil: new Date(untilMs).toISOString(), inventoryTierUsd: tier.trim() })}
        >
          {reg.isPending ? "Preparing…" : "Prepare key registration"}
        </button>
      ) : (
        <WalletButton label="Connect the sponsor wallet" />
      )}
      {reg.error && <ErrorState compact error={reg.error} />}
      {reg.data && (
        <div className="space-y-2">
          <div className="text-[11.5px] text-ink-2">
            Bond for this tier: <span className="num">{reg.data.requiredBondBkrn ?? "unknown"} BKRN</span> · operator has <span className="num">{reg.data.operatorAvailableBkrn ?? "unknown"} BKRN</span> available
          </div>
          {reg.data.warnings.map((x) => (
            <div key={x} className="text-[11.5px] text-warn-ink">
              {x}
            </div>
          ))}
          <TxRunner txs={reg.data.txs} signer={reg.data.signer} signerHint="book sponsor" onConfirmed={() => void utils.agent.list.invalidate({ bookId })} />
        </div>
      )}
    </div>
  );
}

function RevokeRow({ bookId, k }: { bookId: number; k: AgentKey }) {
  const utils = trpc.useUtils();
  const rev = trpc.agent.revoke.useMutation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("REVOKED");
  const active = k.status === "active" || k.activeOnChain === true;
  return (
    <>
      <tr>
        <Td>
          <Hash value={k.key} kind="address" />
        </Td>
        <Td>{k.operator ? <Hash value={k.operator} kind="address" /> : DASH}</Td>
        <Td right num>
          {k.inventoryTierUsd ? fmtUsd(k.inventoryTierUsd, { compact: true }) : DASH}
        </Td>
        <Td num className="text-ink-2">
          {k.validUntil ? fmtDateTime(k.validUntil) : DASH}
        </Td>
        <Td>
          <Chip tone={active ? "good" : "neutral"}>{k.status}</Chip>
          {k.activeOnChain === false && k.status === "active" && <span className="ml-1 text-[10.5px] text-warn-ink">not active on-chain</span>}
        </Td>
        <Td>
          {k.revokedTx ? (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-2">
              {k.revokedReason ?? "revoked"} <Hash value={k.revokedTx} kind="tx" />
            </span>
          ) : (
            <Hash value={k.registeredTx} kind="tx" />
          )}
        </Td>
        <Td right>
          {active && (
            <button type="button" className="btn btn-danger h-7 min-h-7 px-2 text-[12px]" onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : "Revoke"}
            </button>
          )}
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="border-b border-line bg-surface-2 px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason (32 bytes max)" htmlFor={`reason-${k.key}`} className="w-56">
                <input id={`reason-${k.key}`} className="field num" maxLength={32} value={reason} onChange={(e) => (setReason(e.currentTarget.value.toUpperCase()), rev.reset())} />
              </Field>
              <button type="button" className="btn btn-danger" disabled={!reason || rev.isPending} onClick={() => rev.mutate({ bookId, key: k.key, reason })}>
                {rev.isPending ? "Preparing…" : "Prepare revocation"}
              </button>
              <span className="text-[11px] text-muted">Signed by the sponsor, the risk role, the committee or the key itself; effective in the same block.</span>
            </div>
            {rev.error && <div className="mt-2"><ErrorState compact error={rev.error} /></div>}
            {rev.data && (
              <div className="mt-2 space-y-2">
                {rev.data.warnings.map((x) => (
                  <div key={x} className="text-[11.5px] text-warn-ink">
                    {x}
                  </div>
                ))}
                <TxRunner txs={rev.data.txs} signer={null} onConfirmed={() => void utils.agent.list.invalidate({ bookId })} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function BookAgents({ bookId }: { bookId: number }) {
  const q = trpc.agent.list.useQuery({ bookId }, { refetchInterval: POLL.list });
  const book = trpc.book.get.useQuery({ bookId }, { refetchInterval: POLL.slow });
  const now = useNow(1_000);
  const hb = ageMs(q.data?.agent.heartbeatAt ?? null, now);
  return (
    <div className="space-y-4">
      <Panel
        title="Desk keys"
        meta={q.data ? `${q.data.keys.length} key${q.data.keys.length === 1 ? "" : "s"}` : undefined}
        actions={
          q.data && (
            <div className="flex items-center gap-2">
              {q.data.killed && <Chip tone="critical" solid>{`Killed${q.data.killReason ? `: ${q.data.killReason}` : ""}`}</Chip>}
              <Chip tone={q.data.agent.alive ? "good" : "neutral"}>{q.data.agent.alive ? `Agent heartbeat ${hb === null ? "" : `${fmtAgo(hb)}`}` : "No agent heartbeat"}</Chip>
            </div>
          )
        }
      >
        <QueryView
          q={q}
          empty={(d) => d.keys.length === 0}
          emptyView={<EmptyState compact title="No desk keys registered" body="The sponsor registers a session key per agent with an inventory tier at least the mandate's max inventory; the operator's BKRN bond is locked for the tier." />}
        >
          {(d) => (
            <Table minWidth={860}>
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Operator</Th>
                  <Th right>Tier</Th>
                  <Th>Valid until</Th>
                  <Th>Status</Th>
                  <Th>Last tx</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {d.keys.map((k) => (
                  <RevokeRow key={k.key} bookId={bookId} k={k} />
                ))}
              </tbody>
            </Table>
          )}
        </QueryView>
      </Panel>
      <Panel title="Register a desk key" meta="MMMandate.registerKey · signed by the sponsor">
        {q.data?.killed ? (
          <EmptyState compact title="Mandate killed" body="Keys can be registered again after the committee re-mandates the book." />
        ) : (
          <RegisterForm bookId={bookId} maxInventoryUsd={book.data?.mandate?.maxInventoryUsd ?? null} />
        )}
      </Panel>
    </div>
  );
}

export function AgentsPage() {
  const books = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.slow });
  const [params, setParams] = useSearchParams();
  const sel = Number(params.get("book")) || books.data?.[0]?.bookId || null;
  return (
    <>
      <PageHeader eyebrow="Desk" title="Agents" sub={`${AGENTS_LINE} Session keys act on each book's desk only through typed, mandate-checked actions; revocation takes effect in the same block.`} />
      <QueryView
        q={books}
        empty={(d) => d.length === 0}
        emptyView={
          <EmptyState
            title="No books yet"
            body="Desk keys belong to a book. Approve a charter first."
            action={
              <Link className="btn" to="/charters">
                Charters
              </Link>
            }
          />
        }
      >
        {(d) => (
          <>
            <div className="mb-4">
              <Segmented
                value={String(sel ?? "")}
                onChange={(v) => setParams({ book: v })}
                ariaLabel="Book"
                options={d.map((b) => ({ value: String(b.bookId), label: `${tickerOf(b.symbol)} #${b.bookId}` }))}
              />
            </div>
            {sel && <BookAgents key={sel} bookId={sel} />}
          </>
        )}
      </QueryView>
    </>
  );
}
