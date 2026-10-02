// 4. Interactive waterfall simulator. Fee flow: expenses -> 10% carry -> Senior hurdle share -> Junior
// residual (splitDistribution). Losses: Junior -> Senior -> backstop up to the pool (applyMarkPnl). All
// money math is the protocol's shared waterfall code (see ./sim.ts); this file only draws it.
import { type ReactNode, useId, useState } from "react";
import { trpc } from "../../api/trpc";
import { describeError } from "../../lib/errors";
import { tickerOf } from "../../lib/format";
import type { SeriesKey } from "../../lib/palette";
import { SERIES_CLASS } from "../../lib/palette";
import { useBackstopBalance } from "../../wallet/backstop";
import { cx } from "../cx";
import { Term } from "../Term";
import { Badge, Callout, Card, Segmented, ValueKind } from "../ui";
import { CarryPct, useProtocolTerms } from "../ProtocolTerms";
import { LearnSection } from "./parts";
import {
  DEFAULT_SIM,
  type FeeOutcome,
  LAUNCH_TERMS,
  type LossOutcome,
  type SimInput,
  type SimMode,
  feeSentence,
  lossSentence,
  pctText,
  presetFromBook,
  share,
  simulateFees,
  simulateLoss,
  usdText,
} from "./sim";
import { markedBooks, useLiveBooks } from "./useLearnData";

const USDC = (raw: bigint, dp = 2) => `${usdText(raw, dp)} USDC`;
const whole = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** A deduction: "-20.00 USDC", or "0.00 USDC" when nothing is taken. */
const minus = (raw: bigint) => (raw > 0n ? `-${USDC(raw)}` : USDC(0n));

// ------------------------------------------------------------------ controls
function SimField(props: {
  id: string;
  label: ReactNode;
  /** Plain-text label for the exact-amount box. */
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  /** Show an editable number box next to the slider (money amounts). */
  editable?: boolean;
  help?: ReactNode;
}) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, v));
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={props.id} className="min-w-0 text-[13px] font-medium text-ink [&_.term]:text-left">
          {props.label}
        </label>
        {props.editable ? (
          <span className="flex items-center gap-1.5">
            <input
              aria-label={`${props.name}, exact amount in USDC`}
              className="field num !min-h-8 w-28 !px-2 !py-1 text-right !text-[13px]"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={text ?? whole(props.value)}
              onFocus={() => setText(String(Math.round(props.value)))}
              onChange={(e) => {
                const t = e.target.value.replace(/[^\d]/g, "").slice(0, 9);
                setText(t);
                if (t !== "") props.onChange(clamp(Number(t)));
              }}
              onBlur={() => setText(null)}
            />
            <span className="text-[12px] text-muted">USDC</span>
          </span>
        ) : (
          <output htmlFor={props.id} className="num text-[13px] font-medium text-ink">
            {props.format(props.value)}
          </output>
        )}
      </div>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={props.format(props.value)}
        onChange={(e) => props.onChange(clamp(Number(e.currentTarget.value)))}
        className="mt-2 h-2 w-full cursor-pointer accent-[var(--accent)]"
      />
      {props.help && <p className="mt-1 text-[12px] leading-snug text-muted">{props.help}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ bars
interface Seg {
  key: string;
  series?: SeriesKey;
  neutral?: boolean;
  hatch?: boolean;
  amount: bigint;
  label: string;
}

function segClass(s: Seg) {
  if (s.neutral) return "bg-muted/55";
  if (s.hatch) return cx("hatch", SERIES_CLASS.backstop.soft);
  return s.series ? SERIES_CLASS[s.series].bg : "bg-line-strong";
}

/** One horizontal bar split into segments (0..total). */
function StackBar(props: { segs: Seg[]; total: bigint; label: string; className?: string }) {
  return (
    <div className={cx("flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3", props.className)} role="img" aria-label={props.label}>
      {props.segs
        .filter((s) => s.amount > 0n)
        .map((s) => (
          <span key={s.key} className={cx("h-full transition-[width] duration-200", segClass(s))} style={{ width: `${share(s.amount, props.total) * 100}%` }} />
        ))}
    </div>
  );
}

function LegendRow(props: { segs: Seg[] }) {
  return (
    <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2">
      {props.segs.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className={cx("inline-block h-2.5 w-3.5 rounded-[3px]", segClass(s))} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** A waterfall step: a floating bar on the 0..scale axis, the amount and a one-line explanation. */
function Step(props: { n: number; title: ReactNode; amount: ReactNode; note: ReactNode; from: bigint; to: bigint; scale: bigint; seg: Seg; badge?: ReactNode }) {
  const left = share(props.from, props.scale) * 100;
  const width = Math.max(share(props.to - props.from, props.scale) * 100, props.to > props.from ? 0.6 : 0);
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 border-t border-line py-3 first:border-t-0 first:pt-0">
      <span className="tnum mt-0.5 inline-flex size-6 items-center justify-center rounded-full border border-line-strong text-[11.5px] font-semibold text-ink-2" aria-hidden>
        {props.n}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">
            {props.title}
            {props.badge}
          </div>
          <div className="num text-[13.5px] font-medium text-ink">{props.amount}</div>
        </div>
        <div className="relative mt-2 h-2.5 w-full rounded-full bg-surface-3" aria-hidden>
          <span className={cx("absolute inset-y-0 rounded-full transition-[left,width] duration-200", segClass(props.seg))} style={{ left: `${left}%`, width: `${width}%` }} />
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ink-2">{props.note}</p>
      </div>
    </li>
  );
}

function BeforeAfter(props: { rows: Array<{ label: ReactNode; before: bigint; after: bigint; series?: SeriesKey }> }) {
  return (
    <dl className="mt-4 grid gap-2 sm:grid-cols-2">
      {props.rows.map((r, i) => {
        const delta = r.after - r.before;
        return (
          <div key={i} className="rounded-control border border-line bg-surface-2/60 px-3 py-2.5">
            <dt className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
              {r.series && <span className={cx("size-2 rounded-[2px]", SERIES_CLASS[r.series].bg)} aria-hidden />}
              {r.label}
            </dt>
            <dd className="num mt-1 text-[14px] text-ink">
              {usdText(r.before, 0)} <span className="text-muted">to</span> {usdText(r.after, 0)}
              <span className={cx("ml-1.5 text-[12px]", delta > 0n ? "text-fee-ink" : delta < 0n ? "text-loss-ink" : "text-muted")}>
                ({delta > 0n ? "+" : ""}
                {usdText(delta, 2)})
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ------------------------------------------------------------------ results
function FeeResult({ o, hurdleBps, carryBps, expenseCapBps }: { o: FeeOutcome; hurdleBps: number; carryBps: number; expenseCapBps: number }) {
  const segs: Seg[] = [
    { key: "expenses", neutral: true, amount: o.expenses, label: "Expenses" },
    { key: "buyback", series: "bkrn", amount: o.carryToBuyback, label: "Carry: buys BKRN" },
    { key: "backstop", hatch: true, amount: o.carryToBackstop, label: "Carry: backstop pool" },
    { key: "senior", series: "senior", amount: o.senior, label: "Senior" },
    { key: "junior", series: "junior", amount: o.junior, label: "Junior" },
  ];
  const seniorNote =
    o.rule === "all-junior"
      ? "The book has no Senior shares, so Senior's share is zero."
      : o.rule === "all-senior"
        ? "The book has no Junior shares, so Senior receives everything left."
        : `${pctText(hurdleBps)} of what is left after carry, set in the charter as Senior's hurdle share.`;
  return (
    <>
      <div className="text-[12.5px] font-medium text-ink-2">Split of {USDC(o.gross)} of fee flow</div>
      <StackBar
        className="mt-2"
        segs={segs}
        total={o.gross}
        label={`Expenses ${USDC(o.expenses)}, carry ${USDC(o.carry)}, Senior ${USDC(o.senior)}, Junior ${USDC(o.junior)}`}
      />
      <LegendRow segs={segs} />

      <h4 className="mt-6 mb-3 text-[13px] font-semibold text-ink">Where every dollar goes</h4>
      <ol>
        <Step
          n={1}
          title="Fee flow comes in"
          amount={USDC(o.gross)}
          from={0n}
          to={o.gross}
          scale={o.gross}
          seg={{ key: "fee", series: "fee", amount: o.gross, label: "" }}
          note="Fees the market paid to the book over the period."
        />
        <Step
          n={2}
          title="Expenses"
          amount={minus(o.expenses)}
          from={o.net}
          to={o.gross}
          scale={o.gross}
          seg={segs[0] as Seg}
          badge={o.expensesCapped ? <Badge tone="warn" size="sm">Capped</Badge> : undefined}
          note={
            o.expensesCapped
              ? `${USDC(o.expensesRequested)} was asked for, but expenses are capped at ${pctText(expenseCapBps)} of fee flow (${USDC(o.expenseCap)}).`
              : `Oracle and keeper costs, capped at ${pctText(expenseCapBps)} of fee flow. ${USDC(o.net)} is left.`
          }
        />
        <Step
          n={3}
          title={<Term id="carry">Protocol carry</Term>}
          amount={minus(o.carry)}
          from={o.toTranches}
          to={o.net}
          scale={o.gross}
          seg={{ key: "carry", series: "bkrn", amount: o.carry, label: "" }}
          note={`${pctText(carryBps)} of what is left after expenses. ${USDC(o.carryToBuyback)} buys BKRN for stakers and ${USDC(o.carryToBackstop)} goes to the backstop pool.`}
        />
        <Step
          n={4}
          title={<Term id="hurdle">Senior's share of fee flow</Term>}
          amount={USDC(o.senior)}
          from={o.junior}
          to={o.toTranches}
          scale={o.gross}
          seg={segs[3] as Seg}
          note={seniorNote}
        />
        <Step n={5} title="Junior residual" amount={USDC(o.junior)} from={0n} to={o.junior} scale={o.gross} seg={segs[4] as Seg} note="Everything left after Senior's share goes to Junior." />
      </ol>
      <BeforeAfter
        rows={[
          { label: "Senior NAV", before: o.seniorNav, after: o.seniorAfter, series: "senior" },
          { label: "Junior NAV", before: o.juniorNav, after: o.juniorAfter, series: "junior" },
        ]}
      />
    </>
  );
}

function LossResult({ o }: { o: LossOutcome }) {
  const capital = o.seniorNav + o.juniorNav;
  const juniorKept = o.juniorNav - o.juniorLoss;
  const seniorKept = o.seniorNav - o.seniorLoss;
  const segs: Seg[] = [
    { key: "jloss", series: "loss", amount: o.juniorLoss, label: "Loss taken by Junior" },
    { key: "jkept", series: "junior", amount: juniorKept, label: "Junior left" },
    { key: "sloss", series: "loss", amount: o.seniorShortfall, label: "Loss taken by Senior" },
    { key: "cover", hatch: true, amount: o.backstopCovered, label: "Covered by the backstop" },
    { key: "skept", series: "senior", amount: seniorKept, label: "Senior left" },
  ];
  const legend: Seg[] = [{ key: "loss", series: "loss", amount: o.loss, label: "Loss" }, segs[1] as Seg, segs[4] as Seg, segs[3] as Seg];
  return (
    <>
      <div className="text-[12.5px] font-medium text-ink-2">Book capital of {USDC(capital, 0)}, Junior first in line</div>
      <StackBar
        className="mt-2"
        segs={segs}
        total={capital}
        label={`Loss ${USDC(o.loss)}: Junior absorbs ${USDC(o.juniorLoss)}, Senior absorbs ${USDC(o.seniorLoss)}, backstop covers ${USDC(o.backstopCovered)}`}
      />
      <LegendRow segs={legend} />

      <h4 className="mt-6 mb-3 text-[13px] font-semibold text-ink">Where the loss lands</h4>
      <ol>
        <Step
          n={1}
          title="A loss at the mark"
          amount={minus(o.loss)}
          from={0n}
          to={o.loss}
          scale={capital}
          seg={{ key: "loss", series: "loss", amount: o.loss, label: "" }}
          note="The book's NAV at this mark is lower than at the last one, for example after a trading loss on the venue."
        />
        <Step
          n={2}
          title="Junior absorbs first"
          amount={minus(o.juniorLoss)}
          from={0n}
          to={o.juniorLoss}
          scale={o.juniorNav > 0n ? o.juniorNav : 1n}
          seg={{ key: "j", series: "junior", amount: o.juniorLoss, label: "" }}
          note={o.juniorNav === 0n ? "The book has no Junior, so nothing stands in front of Senior." : `Junior NAV goes from ${USDC(o.juniorNav, 0)} to ${USDC(o.juniorAfter, 0)}.`}
        />
        <Step
          n={3}
          title="Senior absorbs the rest"
          amount={minus(o.seniorLoss)}
          from={0n}
          to={o.seniorLoss}
          scale={o.seniorNav > 0n ? o.seniorNav : 1n}
          seg={{ key: "s", series: "senior", amount: o.seniorLoss, label: "" }}
          note={o.seniorLoss === 0n ? "Nothing reaches Senior while Junior still has NAV." : "Junior is used up, so the rest of the loss reaches Senior."}
        />
        <Step
          n={4}
          title={<Term id="backstop">Backstop covers, up to the pool</Term>}
          amount={USDC(o.backstopCovered)}
          from={0n}
          to={o.backstopCovered}
          scale={o.backstopPool > 0n ? o.backstopPool : 1n}
          seg={segs[3] as Seg}
          note={
            o.seniorLoss === 0n
              ? "Not needed: the backstop only steps in once Junior is used up."
              : o.backstopPool === 0n
                ? "The pool is empty, so it covers nothing."
                : `Pays Senior's shortfall from the shared pool, never more than the ${USDC(o.backstopPool, 0)} it holds.`
          }
        />
        <Step
          n={5}
          title={<Term id="drawdown">Drawdown check</Term>}
          amount={pctText(o.drawdownBps)}
          from={0n}
          to={BigInt(Math.min(10_000, Math.abs(o.drawdownBps)))}
          scale={10_000n}
          seg={{ key: "dd", series: "loss", amount: 1n, label: "" }}
          badge={o.killed ? <Badge tone="critical" size="sm">Mandate killed</Badge> : undefined}
          note={
            o.killed
              ? `At or past the kill level of ${pctText(o.killAtDrawdownBps)}: this mark kills the mandate. Quoting stops and agent keys are revoked; redemptions keep working.`
              : `The mandate's kill level is ${pctText(o.killAtDrawdownBps)}. This loss stays above it, so the agent keeps quoting.`
          }
        />
      </ol>
      <BeforeAfter
        rows={[
          { label: "Senior NAV", before: o.seniorNav, after: o.seniorAfter, series: "senior" },
          { label: "Junior NAV", before: o.juniorNav, after: o.juniorAfter, series: "junior" },
          { label: "Backstop pool", before: o.backstopPool, after: o.backstopPool - o.backstopCovered, series: "backstop" },
        ]}
      />
    </>
  );
}

// ------------------------------------------------------------------ simulator
type PresetStatus = { kind: "example" } | { kind: "loading"; bookId: number } | { kind: "book"; bookId: number; label: string } | { kind: "error"; message: string };

export function WaterfallSimulator() {
  const id = useId();
  const [input, setInput] = useState<SimInput>(DEFAULT_SIM);
  const [mode, setMode] = useState<SimMode>("fees");
  const [preset, setPreset] = useState<PresetStatus>({ kind: "example" });
  const utils = trpc.useUtils();
  const books = markedBooks(useLiveBooks().data);
  const pool = useBackstopBalance();
  const set = (patch: Partial<SimInput>) => setInput((p) => ({ ...p, ...patch }));

  const loadBook = async (bookId: number) => {
    setPreset({ kind: "loading", bookId });
    try {
      const d = await utils.book.get.fetch({ bookId });
      // tranche NAVs of the latest signed mark (falls back to the book's current on-chain tranche NAVs)
      const m = d.latestMark;
      const p = presetFromBook(
        {
          seniorNavUsd: m?.seniorNavUsd ?? d.seniorNavUsd,
          juniorNavUsd: m?.juniorNavUsd ?? d.juniorNavUsd,
          seniorHurdleBps: d.charter?.seniorHurdleBps ?? null,
          killAtDrawdownBps: d.mandate?.killAtDrawdownBps ?? null,
        },
        input,
      );
      if (!p) throw new Error("This book has no marked tranche NAV yet.");
      setInput(p);
      setPreset({ kind: "book", bookId, label: tickerOf(d.symbol) });
    } catch (e) {
      setPreset({ kind: "error", message: describeError(e).message });
    }
  };

  const presetValue = preset.kind === "book" || preset.kind === "loading" ? String(preset.bookId) : "example";
  const options = [{ value: "example", label: "Round numbers" }, ...books.map((b) => ({ value: String(b.bookId), label: tickerOf(b.symbol), title: `Start from the ${tickerOf(b.symbol)} book's marked NAV and charter terms` }))];
  // carry and the expense cap as configured on-chain now (launch defaults until read)
  const terms = useProtocolTerms();
  const fees = simulateFees({ ...input, carryBps: terms.carryBps, expenseCapBps: terms.expenseCapBps });
  const loss = simulateLoss(input);
  const poolRaw = pool.data ?? null;
  const seniorOverCap = input.seniorBps > LAUNCH_TERMS.seniorCapBps;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Card padding="lg" aria-label="Simulator settings">
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-[13px] font-medium text-ink">Start from</div>
            <Segmented
              ariaLabel="Start from"
              layout="grid"
              value={presetValue}
              options={options}
              onChange={(v) => {
                if (v === "example") {
                  setInput(DEFAULT_SIM);
                  setPreset({ kind: "example" });
                } else void loadBook(Number(v));
              }}
            />
            <p className="mt-1.5 text-[12px] leading-snug text-muted" aria-live="polite">
              {preset.kind === "example" && "A round 100,000 USDC book with the testnet charter terms."}
              {preset.kind === "loading" && "Loading the book's latest mark and charter terms..."}
              {preset.kind === "book" && (
                <>
                  {preset.label}'s marked Senior and Junior NAV and its charter terms. <ValueKind kind="marked" compact />
                </>
              )}
              {preset.kind === "error" && <span className="text-critical-ink">Could not load that book: {preset.message}</span>}
            </p>
          </div>

          <SimField
            id={`${id}-capital`}
            label="Book capital"
            name="Book capital"
            editable
            value={input.capitalUsd}
            min={1_000}
            max={2_000_000}
            step={1_000}
            format={(v) => `${whole(v)} USDC`}
            onChange={(v) => set({ capitalUsd: v, lossUsd: Math.min(input.lossUsd, v) })}
          />
          <SimField
            id={`${id}-senior`}
            label={
              <>
                <Term id="senior">Senior</Term> share of capital
              </>
            }
            name="Senior share of capital"
            value={input.seniorBps}
            min={0}
            max={9_000}
            step={100}
            format={(v) => `${pctText(v)} Senior, ${pctText(10_000 - v)} Junior`}
            onChange={(v) => set({ seniorBps: v })}
            help={seniorOverCap ? `The testnet books cap Senior at ${pctText(LAUNCH_TERMS.seniorCapBps)} of capital; a real window would refund the excess.` : undefined}
          />

          <div>
            <div className="mb-2 text-[13px] font-medium text-ink">This period</div>
            <Segmented
              ariaLabel="What happens this period"
              layout="stack"
              value={mode}
              options={[
                { value: "fees", label: "Fee flow comes in" },
                { value: "loss", label: "The book loses money" },
              ]}
              onChange={setMode}
            />
          </div>

          {mode === "fees" ? (
            <>
              <SimField
                id={`${id}-fees`}
                label={<Term id="feeFlow">Fee flow for the period</Term>}
                name="Fee flow for the period"
                editable
                value={input.feeFlowUsd}
                min={0}
                max={100_000}
                step={50}
                format={(v) => `${whole(v)} USDC`}
                onChange={(v) => set({ feeFlowUsd: v })}
              />
              <SimField
                id={`${id}-expenses`}
                label="Expenses asked for"
                name="Expenses asked for"
                editable
                value={input.expensesUsd}
                min={0}
                max={10_000}
                step={5}
                format={(v) => `${whole(v)} USDC`}
                onChange={(v) => set({ expensesUsd: v })}
                help={`Oracle and keeper gas. Never more than ${pctText(terms.expenseCapBps)} of the fee flow is paid.`}
              />
              <SimField
                id={`${id}-hurdle`}
                label={<Term id="hurdle">Senior's share of fee flow</Term>}
                name="Senior's share of fee flow"
                value={input.hurdleBps}
                min={0}
                max={10_000}
                step={500}
                format={(v) => pctText(v)}
                onChange={(v) => set({ hurdleBps: v })}
                help="Set in each book's charter. The testnet books use 60%."
              />
            </>
          ) : (
            <>
              <SimField
                id={`${id}-loss`}
                label="Loss at the mark"
                name="Loss at the mark"
                editable
                value={input.lossUsd}
                min={0}
                max={input.capitalUsd}
                step={Math.max(100, Math.round(input.capitalUsd / 200 / 100) * 100)}
                format={(v) => `${whole(v)} USDC`}
                onChange={(v) => set({ lossUsd: v })}
              />
              <SimField
                id={`${id}-pool`}
                label={<Term id="backstop">Backstop pool</Term>}
                name="Backstop pool"
                editable
                value={input.backstopUsd}
                min={0}
                max={1_000_000}
                step={500}
                format={(v) => `${whole(v)} USDC`}
                onChange={(v) => set({ backstopUsd: v })}
                help={
                  poolRaw !== null ? (
                    <>
                      The testnet pool holds {USDC(poolRaw)} right now.{" "}
                      <button type="button" className="link" onClick={() => set({ backstopUsd: Number(poolRaw) / 1e6 })}>
                        Use it
                      </button>
                    </>
                  ) : (
                    "Shared by every book and funded by half of the protocol carry."
                  )
                }
              />
              <p className="text-[12px] text-muted">
                Kill level from the mandate: <span className="num font-medium text-ink-2">{pctText(input.killAtDrawdownBps)}</span> drawdown.
              </p>
            </>
          )}
        </div>
      </Card>

      <Card padding="lg" aria-label="Simulator result">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Badge tone={mode === "fees" ? "fee" : "loss"} dot>
            {mode === "fees" ? "Fee flow period" : "Loss period"}
          </Badge>
          <span className="text-[11.5px] text-muted">Illustration, not a forecast</span>
        </div>
        <p className="mb-5 text-[16px] leading-relaxed font-medium text-ink sm:text-[17px]" aria-live="polite">
          {mode === "fees" ? feeSentence(fees) : lossSentence(loss)}
        </p>
        {mode === "fees" ? <FeeResult o={fees} hurdleBps={input.hurdleBps} carryBps={terms.carryBps} expenseCapBps={terms.expenseCapBps} /> : <LossResult o={loss} />}
        <p className="mt-5 text-[12px] leading-relaxed text-muted">
          {mode === "fees"
            ? "Fee flow is credited to the tranches when the book's router distributes it. Gains in the book's own trading are booked at the mark instead: they first restore any Senior shortfall, then go to Junior."
            : "A gain at a later mark first restores Senior's shortfall, then goes to Junior. Losses beyond the pool stay with Senior: last loss, not no loss."}{" "}
          Computed with the protocol's own waterfall code, the same math the contracts are tested against.
        </p>
      </Card>
    </div>
  );
}

export function SimulatorSection(props: { index: number }) {
  return (
    <LearnSection
      id="simulator"
      index={props.index}
      eyebrow="Try it"
      title="Waterfall simulator"
      lead={
        <>
          Move the sliders to see where each dollar goes. Fee flow runs <em>down</em> the <Term id="waterfall">waterfall</Term>: expenses, then the <CarryPct /> carry,
          then a fixed split between Senior's share and Junior. Losses run <em>up</em> it: Junior, then Senior, then the backstop up to the pool.
        </>
      }
    >
      <WaterfallSimulator />
      <Callout tone="info" compact className="mt-5">
        Numbers you enter are hypothetical. The live books' presets use their latest signed mark and charter terms; nothing here predicts what a book will earn.
      </Callout>
    </LearnSection>
  );
}
