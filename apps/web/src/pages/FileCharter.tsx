// "File a charter": a five-step form (market, capital, mandate, tranche terms, review). Review calls
// charter.file, which validates like MarketCharter.validate and prepares approve / stake / file txs.
import { SESSIONS_24X5, SESSIONS_24X7, SESSIONS_NYSE_RTH, isOpen } from "@bookrunner/shared/sessions";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { trpc } from "../api/trpc";
import { Chip, ErrorState, Field, KV, PageHeader, Panel, Segmented, cx } from "../components/ui";
import {
  type CharterForm,
  DEFAULT_FORM,
  DURATION_UNITS,
  FIELD_HELP,
  type HedgeVenue,
  SESSION_PRESETS,
  STEPS,
  type StepId,
  apiFieldToForm,
  formIssues,
  formToDraft,
  issuesFor,
  splitDuration,
  stepOf,
  suggestSymbol,
} from "../lib/charterForm";
import { TRANCHE_COPY } from "../lib/copy";
import { bpsPct, fmtBps, fmtDuration, fmtNum, fmtUsd } from "../lib/format";
import { useSettlementSymbol } from "../wallet/settlementSymbol";
import { TxRunner } from "../wallet/TxRunner";
import { WalletButton } from "../wallet/WalletButton";
import { useWallet } from "../wallet/WalletContext";

const SESSION_OBJ = { "24x5": SESSIONS_24X5, nyse_rth: SESSIONS_NYSE_RTH, "24x7": SESSIONS_24X7 } as const;
const DRAFT_KEY = "bkrn.charterDraft";

function loadDraft(): CharterForm {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return DEFAULT_FORM;
    const j = JSON.parse(raw) as Partial<CharterForm>;
    return { ...DEFAULT_FORM, ...j, mandate: { ...DEFAULT_FORM.mandate, ...(j.mandate ?? {}) } };
  } catch {
    return DEFAULT_FORM;
  }
}

function DurationInput(props: { id: string; seconds: string; onChange: (s: string) => void; invalid?: boolean }) {
  const init = splitDuration(Number(props.seconds) || 0);
  const [value, setValue] = useState(String(init.value));
  const [unit, setUnit] = useState(init.unit);
  const emit = (v: string, u: typeof unit) => {
    const n = Number(v);
    const size = DURATION_UNITS.find((x) => x.id === u)?.seconds ?? 1;
    props.onChange(Number.isFinite(n) && v.trim() !== "" ? String(Math.round(n * size)) : "");
  };
  return (
    <div className="flex gap-2">
      <input
        id={props.id}
        className="field num"
        inputMode="decimal"
        value={value}
        aria-invalid={props.invalid}
        onChange={(e) => {
          const v = e.currentTarget.value.replace(/[^\d.]/g, "");
          setValue(v);
          emit(v, unit);
        }}
      />
      <select
        className="field w-32"
        value={unit}
        aria-label="Unit"
        onChange={(e) => {
          const u = e.currentTarget.value as typeof unit;
          setUnit(u);
          emit(value, u);
        }}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FileCharterPage() {
  const w = useWallet();
  const sym = useSettlementSymbol();
  const [form, setForm] = useState<CharterForm>(loadDraft);
  const [step, setStep] = useState<StepId>("market");
  const file = trpc.charter.file.useMutation();
  const issues = useMemo(() => formIssues(form), [form]);
  const errors = issues.filter((i) => i.severity === "error");

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    } catch {
      // storage blocked: the draft is not remembered
    }
  }, [form]);

  useEffect(() => {
    if (w.active && !form.sponsor) setForm((f) => ({ ...f, sponsor: w.active?.address ?? "" }));
  }, [w.active, form.sponsor]);

  const set = <K extends keyof CharterForm>(k: K, v: CharterForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    file.reset();
  };
  const setM = <K extends keyof CharterForm["mandate"]>(k: K, v: CharterForm["mandate"][K]) => {
    setForm((f) => ({ ...f, mandate: { ...f.mandate, [k]: v } }));
    file.reset();
  };
  const err = (field: string) => issuesFor(issues, field).find((i) => i.severity === "error")?.message ?? apiIssue(field);
  const warn = (field: string) => issuesFor(issues, field).find((i) => i.severity === "warn")?.message ?? null;
  const apiIssue = (field: string) => file.data?.issues.find((i) => apiFieldToForm(i.field) === field)?.message ?? null;
  const stepErrors = (s: StepId) => errors.filter((i) => i.step === s).length + (file.data?.issues.filter((i) => stepOf(apiFieldToForm(i.field)) === s).length ?? 0);
  const idx = STEPS.findIndex((s) => s.id === step);
  const go = (d: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, idx + d))]?.id ?? "market");

  const raise = Number(form.ifSizeUsd || 0) + Number(form.mmInventoryUsd || 0);
  const seniorMax = (raise * Number(form.seniorCapBps || 0)) / 10_000;

  let body: ReactNode = null;
  if (step === "market") {
    body = (
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Book name" help="Shown on dashboards (optional)" htmlFor="f-name">
          <input id="f-name" className="field" value={form.name} onChange={(e) => set("name", e.currentTarget.value)} maxLength={80} />
        </Field>
        <Field label="Sponsor" help="Pays the flat charter fee, locks the BKRN sponsor bond and holds at least 10% of Junior when the subscription window closes" error={err("sponsor")} htmlFor="f-sponsor">
          <div className="flex gap-2">
            <input id="f-sponsor" className="field num" value={form.sponsor} onChange={(e) => set("sponsor", e.currentTarget.value.trim())} placeholder="0x…" aria-invalid={!!err("sponsor")} />
            {w.active && (
              <button type="button" className="btn" onClick={() => set("sponsor", w.active?.address ?? "")}>
                Use wallet
              </button>
            )}
          </div>
        </Field>
        <Field label="Underlying" help={FIELD_HELP.underlying} error={err("underlying")} htmlFor="f-underlying" className="md:col-span-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Segmented
              value={form.underlyingKind}
              onChange={(v) => set("underlyingKind", v)}
              ariaLabel="Underlying kind"
              options={[
                { value: "ticker", label: "Stock Token ticker" },
                { value: "token", label: "Token address" },
                { value: "index", label: "Index" },
              ]}
            />
            <input
              id="f-underlying"
              className="field num"
              value={form.underlying}
              aria-invalid={!!err("underlying")}
              placeholder={form.underlyingKind === "ticker" ? "NVDA" : form.underlyingKind === "token" ? "0x…" : "RHX5"}
              onChange={(e) => set("underlying", e.currentTarget.value)}
            />
          </div>
        </Field>
        <Field label="Venue" help={FIELD_HELP.venue}>
          <Segmented
            value={form.venue}
            onChange={(v) => set("venue", v)}
            ariaLabel="Venue"
            options={[
              { value: "orderly", label: "Orderly-listed" },
              { value: "pool_engine", label: "In-house engine" },
            ]}
          />
        </Field>
        <Field label="Venue symbol" help={FIELD_HELP.symbol} error={err("symbol")} htmlFor="f-symbol">
          <div className="flex gap-2">
            <input id="f-symbol" className="field num" value={form.symbol} onChange={(e) => set("symbol", e.currentTarget.value.trim())} aria-invalid={!!err("symbol")} />
            {form.underlyingKind !== "token" && (
              <button type="button" className="btn" onClick={() => set("symbol", suggestSymbol(form.underlying, form.venue))}>
                Suggest
              </button>
            )}
          </div>
        </Field>
        <Field label="Oracle plan" help={FIELD_HELP.oracle}>
          <Segmented
            value={form.oracle}
            onChange={(v) => set("oracle", v)}
            ariaLabel="Oracle"
            options={[
              { value: "attested", label: "Attested multi-source" },
              { value: "chainlink", label: "Equity feed reader" },
            ]}
          />
        </Field>
        {form.venue === "pool_engine" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Taker fee (bps)" help={FIELD_HELP.takerFeeBps} error={err("takerFeeBps")} htmlFor="f-taker">
              <input id="f-taker" className="field num" inputMode="numeric" value={form.takerFeeBps} onChange={(e) => set("takerFeeBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
            </Field>
            <Field label="Maker fee (bps)" error={err("makerFeeBps")} htmlFor="f-maker">
              <input id="f-maker" className="field num" inputMode="numeric" value={form.makerFeeBps} onChange={(e) => set("makerFeeBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
            </Field>
          </div>
        ) : (
          <div />
        )}
        <div className="md:col-span-2">
          <div className="mb-1 text-[12px] font-medium">Sessions</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {SESSION_PRESETS.map((p) => {
              const on = form.sessions === p.id;
              const open = isOpen(SESSION_OBJ[p.id]);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("sessions", p.id)}
                  className={cx("rounded-card border p-2.5 text-left", on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold">{p.label}</span>
                    <Chip tone={open ? "good" : "neutral"}>{open ? "in session now" : "held now"}</Chip>
                  </div>
                  <div className="mt-1 text-[11.5px] text-ink-2">{p.detail}</div>
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-[11.5px] text-muted">{FIELD_HELP.sessions}</div>
        </div>
      </div>
    );
  } else if (step === "capital") {
    body = (
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={`IF size (${sym})`} help={FIELD_HELP.ifSizeUsd} error={err("ifSizeUsd")} htmlFor="f-if">
          <input id="f-if" className="field num" inputMode="decimal" value={form.ifSizeUsd} aria-invalid={!!err("ifSizeUsd")} onChange={(e) => set("ifSizeUsd", e.currentTarget.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field label={`MM inventory (${sym})`} help={FIELD_HELP.mmInventoryUsd} error={err("mmInventoryUsd")} htmlFor="f-mm">
          <input id="f-mm" className="field num" inputMode="decimal" value={form.mmInventoryUsd} aria-invalid={!!err("mmInventoryUsd")} onChange={(e) => set("mmInventoryUsd", e.currentTarget.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <div className="rounded-card border border-line bg-surface-2 p-3 md:col-span-2">
          <KV
            rows={[
              ["Maximum raise (IF + MM)", fmtUsd(String(raise), { symbol: true })],
              ["Deployment order at close", "IF first, then MM inventory; any remainder stays idle in the vault"],
              ["Senior at most (cap)", fmtUsd(String(seniorMax), { symbol: true })],
            ]}
          />
        </div>
      </div>
    );
  } else if (step === "mandate") {
    const m = form.mandate;
    const lo = Number(m.hedgeRatioMinBps);
    const hi = Number(m.hedgeRatioMaxBps);
    const span = Math.max(hi * 1.25, 10_000);
    body = (
      <div className="space-y-5">
        <p className="max-w-3xl text-[12.5px] text-ink-2">The mandate bounds what bookrunner agents may do on this book. It is enforced pre-trade by the agent, on-chain by the mandate and desk contracts, and continuously by the risk monitor; a breach cancels quotes, flattens within the mandate and revokes keys.</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Max inventory (USD)" help={FIELD_HELP["mandate.maxInventoryUsd"]} error={err("mandate.maxInventoryUsd")} htmlFor="m-inv">
            <input id="m-inv" className="field num" inputMode="decimal" value={m.maxInventoryUsd} onChange={(e) => setM("maxInventoryUsd", e.currentTarget.value.replace(/[^\d.]/g, ""))} />
          </Field>
          <Field label="Max skew (bps)" help={FIELD_HELP["mandate.maxSkewBps"]} error={err("mandate.maxSkewBps")} htmlFor="m-skew">
            <input id="m-skew" className="field num" inputMode="numeric" value={m.maxSkewBps} onChange={(e) => setM("maxSkewBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field label="Min quote width (bps)" help={FIELD_HELP["mandate.minQuoteWidthBps"]} error={err("mandate.minQuoteWidthBps")} htmlFor="m-width">
            <input id="m-width" className="field num" inputMode="numeric" value={m.minQuoteWidthBps} onChange={(e) => setM("minQuoteWidthBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field label="Kill at drawdown (bps)" help={FIELD_HELP["mandate.killAtDrawdownBps"]} error={err("mandate.killAtDrawdownBps")} htmlFor="m-kill">
            <input id="m-kill" className="field num" inputMode="numeric" value={m.killAtDrawdownBps} onChange={(e) => setM("killAtDrawdownBps", e.currentTarget.value.replace(/[^\d-]/g, ""))} />
          </Field>
          <Field label="Max hedge leverage (x)" help={FIELD_HELP["mandate.maxHedgeLeverage"]} error={err("mandate.maxHedgeLeverage")} htmlFor="m-lev">
            <input id="m-lev" className="field num" inputMode="decimal" value={m.maxHedgeLeverage} onChange={(e) => setM("maxHedgeLeverage", e.currentTarget.value.replace(/[^\d.]/g, ""))} />
          </Field>
          <Field label="Off-hours" help={FIELD_HELP["mandate.noNewRiskOffHours"]}>
            <label className="flex h-[34px] items-center gap-2 text-[13px]">
              <input type="checkbox" checked={m.noNewRiskOffHours} onChange={(e) => setM("noNewRiskOffHours", e.currentTarget.checked)} className="size-4 accent-[var(--accent)]" />
              No new risk outside the session
            </label>
          </Field>
        </div>
        <div className="rounded-card border border-line p-3">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Hedge band from (bps)" error={err("mandate.hedgeRatioMinBps")} htmlFor="m-lo">
              <input id="m-lo" className="field num" inputMode="numeric" value={m.hedgeRatioMinBps} onChange={(e) => setM("hedgeRatioMinBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
            </Field>
            <Field label="to (bps)" error={err("mandate.hedgeRatioMaxBps")} htmlFor="m-hi">
              <input id="m-hi" className="field num" inputMode="numeric" value={m.hedgeRatioMaxBps} onChange={(e) => setM("hedgeRatioMaxBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
            </Field>
            <div>
              <div className="mb-1 text-[12px] font-medium">Band</div>
              <div className="relative mt-3 h-2 rounded-[1px] bg-surface-3">
                {Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && (
                  <div className="absolute inset-y-0 bg-good/50" style={{ left: `${(lo / span) * 100}%`, width: `${((hi - lo) / span) * 100}%` }} />
                )}
                <div className="absolute -inset-y-1 w-px bg-ink/60" style={{ left: `${(10_000 / span) * 100}%` }} title="1.0x" />
              </div>
              <div className="num mt-1 flex justify-between text-[10.5px] text-muted">
                <span>0%</span>
                <span>
                  {bpsPct(lo)} to {bpsPct(hi)} of exposure
                </span>
                <span>{bpsPct(span)}</span>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11.5px] text-muted">{FIELD_HELP["mandate.hedgeRatio"]}</p>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium">Hedge allow-list</span>
            <button type="button" className="btn h-7 min-h-7 text-[12px]" onClick={() => setM("hedgeAllow", [...m.hedgeAllow, { asset: "", venue: "UNIV3" }])}>
              Add pair
            </button>
          </div>
          <div className="text-[11.5px] text-muted">{FIELD_HELP["mandate.hedgeAllow"]}</div>
          {warn("mandate.hedgeAllow") && <div className="mt-1 text-[11.5px] text-warn-ink">{warn("mandate.hedgeAllow")}</div>}
          <ul className="mt-2 space-y-2">
            {m.hedgeAllow.map((h, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className="field num max-w-xs"
                  value={h.asset}
                  placeholder="Ticker, token address or bytes32"
                  aria-label={`Hedge asset ${i + 1}`}
                  aria-invalid={!!err(`mandate.hedgeAllow.${i}`)}
                  onChange={(e) => setM("hedgeAllow", m.hedgeAllow.map((x, j) => (j === i ? { ...x, asset: e.currentTarget.value.trim() } : x)))}
                />
                <select
                  className="field w-36"
                  value={h.venue}
                  aria-label={`Hedge venue ${i + 1}`}
                  onChange={(e) => setM("hedgeAllow", m.hedgeAllow.map((x, j) => (j === i ? { ...x, venue: e.currentTarget.value as HedgeVenue } : x)))}
                >
                  <option value="UNIV3">Uniswap v3 spot</option>
                  <option value="UNIV4">Uniswap v4 spot</option>
                  <option value="ORDERLY">Orderly perp</option>
                  <option value="ENGINE">In-house perp</option>
                </select>
                <button type="button" className="btn btn-ghost h-8 min-h-8 text-[12px]" onClick={() => setM("hedgeAllow", m.hedgeAllow.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  } else if (step === "tranches") {
    body = (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {(["senior", "junior"] as const).map((t) => (
            <div key={t} className={cx("rounded-card border p-3", t === "senior" ? "border-senior/60" : "border-junior/60")}>
              <div className="flex items-center gap-1.5">
                <span className={cx("size-2 rounded-[1px]", t === "senior" ? "bg-senior" : "bg-junior")} aria-hidden />
                <span className="text-[13px] font-semibold">{TRANCHE_COPY[t].name}</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-2">{TRANCHE_COPY[t].line}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Senior cap (bps of book capital)" help={`${FIELD_HELP.seniorCapBps}: ${bpsPct(Number(form.seniorCapBps))}`} error={err("seniorCapBps")} htmlFor="t-cap">
            <input id="t-cap" className="field num" inputMode="numeric" value={form.seniorCapBps} onChange={(e) => set("seniorCapBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field label="Senior share of fee flow (bps)" help={`${FIELD_HELP.seniorShareBps}: ${bpsPct(Number(form.seniorShareBps))}`} error={err("seniorShareBps")} htmlFor="t-share">
            <input id="t-share" className="field num" inputMode="numeric" value={form.seniorShareBps} onChange={(e) => set("seniorShareBps", e.currentTarget.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field label={`Per-wallet cap (${sym})`} help={FIELD_HELP.perWalletCapUsd} error={err("perWalletCapUsd")} htmlFor="t-wallet">
            <input id="t-wallet" className="field num" inputMode="decimal" value={form.perWalletCapUsd} onChange={(e) => set("perWalletCapUsd", e.currentTarget.value.replace(/[^\d.]/g, ""))} />
          </Field>
          <Field label="Subscription window" help={`${FIELD_HELP.windowSeconds} · ${fmtDuration(Number(form.windowSeconds))}`} error={err("windowSeconds")} htmlFor="t-window">
            <DurationInput id="t-window" seconds={form.windowSeconds} onChange={(s) => set("windowSeconds", s)} invalid={!!err("windowSeconds")} />
          </Field>
          <Field label="Junior notice" help={`${FIELD_HELP.juniorNoticeSeconds} · ${fmtDuration(Number(form.juniorNoticeSeconds))}`} error={err("juniorNoticeSeconds")} htmlFor="t-notice">
            <DurationInput id="t-notice" seconds={form.juniorNoticeSeconds} onChange={(s) => set("juniorNoticeSeconds", s)} invalid={!!err("juniorNoticeSeconds")} />
          </Field>
        </div>
        <div className="rounded-card border border-line bg-surface-2 p-3 text-[12px] text-ink-2">
          Fee flow each period: expenses (capped) are paid first, then protocol carry; of the remainder Senior takes {bpsPct(Number(form.seniorShareBps))} and Junior the residual. Losses at a mark: Junior
          first, then Senior, then the backstop up to the pool.
        </div>
      </div>
    );
  } else {
    const d = formToDraft(form);
    body = (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <KV
            rows={[
              ["Underlying", `${form.underlying} (${form.underlyingKind})`],
              ["Venue · symbol", `${form.venue === "orderly" ? "Orderly-listed" : "In-house engine"} · ${form.symbol}`],
              ["Oracle · sessions", `${form.oracle} · ${SESSION_PRESETS.find((p) => p.id === form.sessions)?.label}`],
              ["IF size · MM inventory", `${fmtUsd(d.ifTargetUsd as string, { compact: true, symbol: true })} · ${fmtUsd(d.mmInventoryUsd as string, { compact: true, symbol: true })}`],
              ["Senior cap · Senior share", `${bpsPct(d.seniorCapBps)} · ${bpsPct(d.seniorHurdleBps)}`],
              ["Window · Junior notice", `${fmtDuration(d.subscriptionWindowSeconds)} · ${fmtDuration(d.juniorNoticeSeconds)}`],
            ]}
          />
          <KV
            rows={[
              ["Max inventory", fmtUsd(form.mandate.maxInventoryUsd, { symbol: true })],
              ["Max skew · min width", `${fmtBps(Number(form.mandate.maxSkewBps))} · ${fmtBps(Number(form.mandate.minQuoteWidthBps))}`],
              ["Hedge band", `${bpsPct(Number(form.mandate.hedgeRatioMinBps))} to ${bpsPct(Number(form.mandate.hedgeRatioMaxBps))}`],
              ["Kill at drawdown", fmtBps(Number(form.mandate.killAtDrawdownBps))],
              ["Hedge pairs", form.mandate.hedgeAllow.map((h) => `${h.asset}@${h.venue}`).join(", ") || "none"],
              ["Sponsor", form.sponsor || "—"],
            ]}
          />
        </div>
        {errors.length > 0 ? (
          <div className="rounded-card border border-critical/40 bg-critical/5 p-3">
            <div className="text-[12.5px] font-semibold">Fix {errors.length} field{errors.length === 1 ? "" : "s"} before filing</div>
            <ul className="mt-1 space-y-0.5 text-[12px]">
              {errors.map((i) => (
                <li key={`${i.field}-${i.message}`}>
                  <button type="button" className="link" onClick={() => setStep(i.step)}>
                    {STEPS.find((s) => s.id === i.step)?.label}
                  </button>
                  : {i.message}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={file.isPending} onClick={() => file.mutate(formToDraft(form))}>
              {file.isPending ? "Validating…" : "Validate and prepare filing"}
            </button>
            {!w.active && <WalletButton label="Connect the sponsor wallet" />}
          </div>
        )}
        {file.error && <ErrorState compact error={file.error} />}
        {file.data && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={file.data.ok ? "good" : "critical"}>{file.data.ok ? "Valid charter" : `${file.data.issues.length} issue(s)`}</Chip>
              <span className="text-[11.5px] text-muted">
                validated locally{file.data.validatedBy.chain ? ", by MarketCharter.validate" : ""}
                {file.data.validatedBy.charterService ? " and by the charter service" : ""}
              </span>
            </div>
            {file.data.issues.length > 0 && (
              <ul className="space-y-1 rounded-card border border-critical/40 bg-critical/5 p-3 text-[12px]">
                {file.data.issues.map((i) => (
                  <li key={`${i.code}-${i.field}`}>
                    <span className="num font-medium">{i.code}</span> {i.message}{" "}
                    <button type="button" className="link" onClick={() => setStep(stepOf(apiFieldToForm(i.field)))}>
                      edit
                    </button>
                    <span className="ml-1 text-muted">({i.source})</span>
                  </li>
                ))}
              </ul>
            )}
            {file.data.warnings.map((x) => (
              <div key={x} className="text-[11.5px] text-warn-ink">
                {x}
              </div>
            ))}
            {file.data.fee && (
              <KV
                rows={[
                  ["Flat charter fee (refunded on rejection)", fmtUsd(file.data.fee.charterFeeUsd, { symbol: true })],
                  ["Sponsor bond (BKRN, locked)", Number.isFinite(Number(file.data.fee.sponsorBondBkrn)) ? fmtNum(Number(file.data.fee.sponsorBondBkrn), 0) : file.data.fee.sponsorBondBkrn],
                ]}
              />
            )}
            <TxRunner txs={file.data.txs} signer={file.data.signer} signerHint="sponsor" />
            {file.data.ok && file.data.txs.length > 0 && (
              <p className="text-[11.5px] text-muted">
                Once filed, the charter appears under{" "}
                <Link className="link" to="/charters">
                  Charters
                </Link>{" "}
                and the model jury starts its review.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/charters" className="hover:text-ink">
            Charters / new
          </Link>
        }
        title="File a charter"
        sub="Propose a perp market for the syndicate to underwrite. The draft is kept in this browser until filed."
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => (setForm({ ...DEFAULT_FORM, sponsor: w.active?.address ?? "" }), file.reset(), setStep("market"))}>
            Reset to example
          </button>
        }
      />
      <ol className="scroll-x mb-4 flex gap-1 border-b border-line">
        {STEPS.map((s, i) => {
          const n = s.id === "review" ? 0 : stepErrors(s.id);
          const on = s.id === step;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setStep(s.id)}
                aria-current={on ? "step" : undefined}
                className={cx("-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-2 text-[12.5px] font-medium whitespace-nowrap", on ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink")}
              >
                <span className={cx("num inline-flex size-5 items-center justify-center rounded-[5px] text-[11px]", on ? "bg-ink text-surface" : "bg-surface-3")}>{i + 1}</span>
                {s.label}
                {n > 0 && <span className="num rounded-[4px] bg-critical/15 px-1 text-[10.5px] text-critical-ink">{n}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <Panel title={STEPS[idx]?.label}>
        {body}
        <div className="mt-5 flex items-center justify-between border-t border-line pt-3">
          <button type="button" className="btn" disabled={idx === 0} onClick={() => go(-1)}>
            Back
          </button>
          {step !== "review" && (
            <button type="button" className="btn btn-primary" onClick={() => go(1)}>
              Next: {STEPS[idx + 1]?.label}
            </button>
          )}
        </div>
      </Panel>
    </>
  );
}
