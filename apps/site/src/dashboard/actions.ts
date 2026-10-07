// Modal forms and on-chain actions. Every action ends in real transactions signed by the connected
// wallet: the API prepares them (subscribe, redeem, claim, charter filing, committee vote, desk
// keys) or this desk encodes them (test USDC, staking, top-up round). Each step is simulated with
// eth_call right before its wallet prompt; failures are decoded into plain language.
import type { Address } from "viem";
import { getAddress, isAddress, stringToBytes } from "viem";
import { ApiError, mutate, query } from "./api";
import { BKRN_DECIMALS, USDC_DECIMALS, amountIssue, amountIssueText, apiAmount, formatAmountDisplay, formatAmountInput, normalizeAmount, parseAmount } from "./amount";
import { publicClient, waitForReceipt } from "./chain";
import { CHAIN, txUrl } from "./config";
import { date, dateTime, duration, esc, short, usd } from "./format";
import { badge, notice, splitList } from "./html";
import { bookTicker, depositWindow, markRow, positionView, termsView } from "./model";
import { errText } from "./revert";
import { type Role, ROLES, selected, store } from "./store";
import {
  type StepItem,
  type TxStep,
  cancelUnstakeStep,
  claimRewardStep,
  fromPrepared,
  initialItems,
  mintTestUsdcStep,
  openTopUpStep,
  requestUnstakeStep,
  runSteps,
  stakeSteps,
  summarize,
  withdrawUnstakedStep,
} from "./txs";
import { type WalletManager, safeIcon } from "./wallet";

export interface ActionHost {
  wallet: WalletManager;
  modal: HTMLDialogElement;
  notify(message: string, error?: boolean): void;
  /** Re-read wallet-dependent and current-view data now (and once more a few seconds later). */
  refresh(): void;
  render(): void;
}

let host: ActionHost;
export const initActions = (h: ActionHost) => {
  host = h;
};

const DRAFTS_KEY = "bookrunner.site.drafts.v1";
let drafts: Record<string, Record<string, string>> = {};
try {
  drafts = JSON.parse(globalThis.localStorage?.getItem(DRAFTS_KEY) ?? "{}") ?? {};
} catch {
  drafts = {};
}
const saveDrafts = () => {
  try {
    globalThis.localStorage?.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* not remembered */
  }
};

const roleLabel = (r: Role) => ROLES.find(([k]) => k === r)?.[1] ?? r;

// ------------------------------------------------------------------ form fields
const field = (label: string, name: string, value: string | number = "", type = "text", extra = "", full = false) =>
  `<label class="field ${full ? "full" : ""}">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const select = (label: string, name: string, choices: Array<[string, string]>, value: string, full = false) =>
  `<label class="field ${full ? "full" : ""}">${label}<select name="${name}">${choices.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
const amountField = (label: string, name: string, value: string, full = true) => field(label, name, value, "text", 'inputmode="decimal" autocomplete="off" required', full);

function shell(eyebrow: string, title: string, inner: string): void {
  host.modal.innerHTML = `<div class="modal-top"><p class="eyebrow">${esc(eyebrow)} / BOOKRUNNER</p><button class="close-modal" aria-label="Close" type="button">×</button></div><h2 id="modal-title">${title}</h2>${inner}`;
  (host.modal.querySelector(".close-modal") as HTMLButtonElement).onclick = () => host.modal.close();
  if (!host.modal.open) host.modal.showModal();
}

type Submit = (values: Record<string, string>, form: HTMLFormElement) => Promise<void>;

function openForm(kind: string, eyebrow: string, title: string, body: string, submitLabel: string, onSubmit: Submit): void {
  shell(
    eyebrow,
    title,
    `<form id="action-form" novalidate><div class="form-grid">${body}</div><div class="form-error" role="alert"></div><div class="form-footer"><span class="br-source-note">${esc(roleLabel(store.role))} view · on-chain permissions decide</span><button class="btn" type="submit">${submitLabel}</button></div></form>`,
  );
  const form = host.modal.querySelector("form") as HTMLFormElement;
  const saved = drafts[kind];
  if (saved) {
    for (const el of Array.from(form.elements) as HTMLInputElement[]) {
      if (!el.name || !(el.name in saved) || el.dataset.fixed) continue;
      if (el.type === "checkbox") el.checked = saved[el.name] === "on";
      else el.value = saved[el.name] ?? el.value;
    }
  }
  form.oninput = () => {
    drafts[kind] = Object.fromEntries(Array.from(new FormData(form).entries()).map(([k, v]) => [k, String(v)]));
    saveDrafts();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector("[type=submit]") as HTMLButtonElement;
    const errorEl = form.querySelector(".form-error") as HTMLElement;
    errorEl.textContent = "";
    submit.disabled = true;
    const values: Record<string, string> = {};
    for (const el of Array.from(form.elements) as HTMLInputElement[]) if (el.name) values[el.name] = el.type === "checkbox" ? (el.checked ? "on" : "") : el.value;
    try {
      await onSubmit(values, form);
      delete drafts[kind];
      saveDrafts();
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : errText(err);
    } finally {
      submit.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ wallet gate
async function requireWallet(): Promise<Address> {
  const s = host.wallet.snapshot;
  if (!s.address) {
    openConnect();
    throw new Error("Connect a wallet first.");
  }
  if (!host.wallet.onRightChain) {
    await host.wallet.switchChain();
    if (!host.wallet.onRightChain) throw new Error(`Switch your wallet to ${CHAIN.name} (chain ${CHAIN.id}) first.`);
  }
  return s.address;
}

// ------------------------------------------------------------------ review + run
const STATUS_TEXT: Record<StepItem["status"], string> = {
  queued: "Queued",
  simulating: "Simulating",
  signing: "Confirm in wallet",
  pending: "Waiting for confirmation",
  confirmed: "Confirmed",
  failed: "Failed",
  skipped: "Not sent",
};

function stepsHtml(items: StepItem[]): string {
  return `<ol class="tx-steps">${items
    .map((it, i) => {
      const link = it.hash && txUrl(it.hash) ? ` <a class="hash" href="${esc(txUrl(it.hash))}" target="_blank" rel="noopener">${esc(short(it.hash))} ↗</a>` : "";
      const cls = it.status === "confirmed" ? "live" : it.status === "failed" ? "killed" : it.status === "skipped" ? "rejected" : it.status === "queued" ? "" : "queued";
      return `<li><span class="tx-step-index">${i + 1}</span><div><p>${esc(it.step.description)}${it.step.signer ? `<small>Signed by ${esc(short(it.step.signer))}</small>` : ""}</p>${it.error ? `<p class="form-error">${esc(it.error)}</p>` : ""}</div><div class="tx-step-status">${badge(STATUS_TEXT[it.status], cls)}${link}</div></li>`;
    })
    .join("")}</ol>`;
}

export function review(eyebrow: string, title: string, steps: TxStep[], info: string, warnings: string[] = []): void {
  let items = initialItems(steps);
  let running = false;
  const warn = warnings.length ? notice(warnings.map(esc).join("<br>"), "warn") : "";
  shell(
    eyebrow,
    title,
    `<div class="tx-review">${info}${warn}<div data-steps>${stepsHtml(items)}</div></div><div class="form-error" role="alert"></div><div class="form-footer"><span class="br-source-note">${steps.length} transaction${steps.length === 1 ? "" : "s"} · each simulated before your wallet asks</span><button class="btn" type="button" data-run>${steps.length > 1 ? `Sign ${steps.length} transactions` : "Sign transaction"}</button></div>`,
  );
  const stepsEl = host.modal.querySelector("[data-steps]") as HTMLElement;
  const runBtn = host.modal.querySelector("[data-run]") as HTMLButtonElement;
  const errorEl = host.modal.querySelector(".tx-review + .form-error") as HTMLElement;
  runBtn.onclick = async () => {
    if (running) return;
    const sum = summarize(items);
    if (sum.allConfirmed) {
      host.modal.close();
      return;
    }
    running = true;
    runBtn.disabled = true;
    errorEl.textContent = "";
    try {
      await requireWallet();
      const me = host.wallet.snapshot.address as Address;
      const r = await runSteps(
        items,
        {
          account: () => host.wallet.snapshot.address,
          simulate: async (st) => {
            await publicClient.call({ account: me, to: st.to, data: st.data, value: st.value });
          },
          send: (st) => host.wallet.sendTransaction(st),
          wait: (hash) => waitForReceipt(hash),
        },
        (next) => {
          items = next;
          stepsEl.innerHTML = stepsHtml(items);
        },
      );
      items = r.items;
      if (r.ok) {
        runBtn.textContent = "Close";
        host.notify(`${title}: confirmed on ${CHAIN.name}.`);
        host.refresh();
      } else {
        runBtn.textContent = "Retry";
        const failed = items.find((i) => i.status === "failed" || i.status === "skipped");
        errorEl.textContent = failed?.error ?? "A step did not complete.";
        if (items.some((i) => i.status === "confirmed")) host.refresh();
      }
    } catch (e) {
      errorEl.textContent = errText(e);
    } finally {
      running = false;
      runBtn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ connect / wallet menu
export function openConnect(): void {
  const s = host.wallet.snapshot;
  const list = s.wallets.length
    ? `<div class="wallet-list">${s.wallets
        .map((w) => {
          const icon = safeIcon(w.info.icon);
          return `<button type="button" class="btn-outline wallet-option" data-connect="${esc(w.info.rdns)}">${icon ? `<img src="${esc(icon)}" alt="" width="22" height="22">` : ""}<span>${esc(w.info.name)}</span></button>`;
        })
        .join("")}</div>`
    : `<p class="empty">No browser wallet found. Install a wallet extension that supports EIP-1193 / EIP-6963, then reload this page.</p>`;
  shell("WALLET", "Connect a wallet", `${list}<div class="form-error" role="alert">${s.error ? esc(s.error) : ""}</div>${notice(`This desk asks your wallet for its address only. Transactions go to ${esc(CHAIN.name)} (chain ${CHAIN.id}); you confirm each one in the wallet. ${esc("Testnet tokens have no value.")}`)}`);
  host.modal.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await host.wallet.connect(b.dataset.connect as string);
        host.modal.close();
        host.notify("Wallet connected.");
      } catch (e) {
        (host.modal.querySelector(".form-error") as HTMLElement).textContent = errText(e);
      } finally {
        b.disabled = false;
      }
    };
  });
}

export function openWalletMenu(): void {
  const s = host.wallet.snapshot;
  if (!s.address) return openConnect();
  shell(
    "WALLET",
    "Your wallet",
    `${splitList([
      ["Wallet", esc(s.active?.info.name ?? "Browser wallet")],
      ["Account", `<span class="hash">${esc(s.address)}</span>`],
      ["Network", host.wallet.onRightChain ? esc(CHAIN.name) : `Chain ${s.chainId ?? "unknown"} (not ${esc(CHAIN.name)})`],
    ])}<div class="form-error" role="alert"></div><div class="btn-row">${host.wallet.onRightChain ? "" : '<button type="button" class="btn" data-w="switch">Switch network</button>'}<button type="button" class="btn-outline" data-w="copy">Copy address</button><a class="btn-outline" href="${esc(`${CHAIN.explorerUrl}/address/${s.address}`)}" target="_blank" rel="noopener">Explorer ↗</a><button type="button" class="btn-small danger" data-w="disconnect">Disconnect</button></div>`,
  );
  const errEl = host.modal.querySelector(".form-error") as HTMLElement;
  host.modal.querySelectorAll<HTMLButtonElement>("[data-w]").forEach((b) => {
    b.onclick = async () => {
      try {
        if (b.dataset.w === "switch") {
          await host.wallet.switchChain();
          host.modal.close();
        } else if (b.dataset.w === "copy") {
          await navigator.clipboard.writeText(s.address as string);
          host.notify("Address copied.");
        } else if (b.dataset.w === "disconnect") {
          host.wallet.disconnect();
          host.modal.close();
          host.notify("Wallet disconnected from this desk.");
        }
      } catch (e) {
        errEl.textContent = errText(e);
      }
    };
  });
}

export async function switchChain(): Promise<void> {
  try {
    if (!host.wallet.snapshot.address) return openConnect();
    await host.wallet.switchChain();
    host.notify(host.wallet.onRightChain ? `Switched to ${CHAIN.name}.` : "The wallet stayed on another network.", !host.wallet.onRightChain);
  } catch (e) {
    host.notify(errText(e), true);
  }
}

// ------------------------------------------------------------------ helpers
const bookOf = (id: unknown) => (store.books ?? []).find((b) => b.bookId === Number(id)) ?? selected();
const trancheChoices: Array<[string, string]> = [
  ["senior", "Senior · first fee claim, last loss"],
  ["junior", "Junior · residual fee flow, first loss"],
];
const asTranche = (v: unknown): "senior" | "junior" => (v === "junior" ? "junior" : "senior");

function needAmount(value: string, opts: { decimals?: number; balance?: bigint | null; max?: bigint | null; symbol?: string }): string {
  const issue = amountIssue(value, { decimals: opts.decimals ?? USDC_DECIMALS, balance: opts.balance ?? null, max: opts.max ?? null });
  if (issue) throw new Error(amountIssueText(issue, opts.symbol ?? "USDC") ?? "Check the amount.");
  return normalizeAmount(value, opts.decimals ?? USDC_DECIMALS) as string;
}

// ------------------------------------------------------------------ forms
export function openAction(kind: string, args: Record<string, unknown>): void {
  switch (kind) {
    case "subscribe":
      return subscribeForm(args);
    case "redeem":
      return redeemForm(args);
    case "topup":
      return topUpForm(args);
    case "charterFile":
      return charterFileForm();
    case "charterVote":
      return charterVoteForm(args);
    case "agentRegister":
      return agentRegisterForm(args);
    case "agentRevoke":
      return agentRevokeForm(args);
    case "stake":
      return stakeForm();
    case "unstake":
      return unstakeForm();
    default:
      host.notify("This action is not available on the live desk.", true);
  }
}

function subscribeForm(args: Record<string, unknown>): void {
  const b = bookOf(args.bookId);
  if (!b) return host.notify("No book is open yet.", true);
  const d = store.details[b.bookId];
  const t = asTranche(args.tranche);
  const terms = d ? termsView(d) : null;
  const w = depositWindow(d?.state ?? b.state, d?.subscriptionEnds ?? b.subscriptionEnds, store.topUps[b.bookId] ?? null, Math.floor(Date.now() / 1000), b.markSchedule?.intervalSeconds ?? null);
  const bal = store.balancesOwner === host.wallet.snapshot.address ? store.balances?.usdc : null;
  const windowText =
    w.kind === "subscription"
      ? w.open
        ? `Subscription window open until ${dateTime(w.endsAt)}; allocation is pro-rata at window close.`
        : "The subscription window has closed."
      : w.kind === "topup"
        ? `Top-up round open until ${dateTime(w.endsAtSec)}. Capacity: Senior $${formatAmountDisplay(w.seniorCapacityUsd)}, Junior $${formatAmountDisplay(w.juniorCapacityUsd)}. It settles at the first mark on or after the round end${w.settlesAtSec ? ` (${dateTime(w.settlesAtSec)})` : ""}, at that mark's share price.`
        : w.reason;
  const ticker = bookTicker(b.symbol, d?.charter?.ticker);
  openForm(
    "subscribe",
    ticker,
    "Subscribe to the book",
    select("Tranche", "tranche", trancheChoices, t, true) +
      amountField("Capital · USDC", "amount", "1000") +
      `<div class="notice field full"><strong>${esc(ticker)} · ${esc(d?.state ?? b.state)}</strong><br>${esc(windowText)}<br>Wallet USDC: ${bal == null ? (host.wallet.snapshot.address ? "reading…" : "connect a wallet") : `$${formatAmountDisplay(bal)}`}. Per-wallet cap per round: ${terms?.perWalletCapUsd ? usd(terms.perWalletCapUsd) : "none"}. Senior cap: ${terms?.seniorCapBps != null ? `${terms.seniorCapBps / 100}% of book capital` : "per charter"}.<br>Deposits stay in escrow until the first mark after the round end and cannot be cancelled before. Testnet USDC has no value.</div>`,
    "Review deposit",
    async (v) => {
      const me = await requireWallet();
      const amountUsd = needAmount(v.amount ?? "", { balance: store.balancesOwner === me ? (store.balances?.usdc ?? null) : null });
      const tranche = asTranche(v.tranche);
      const res = await mutate("tranche.subscribe", { bookId: b.bookId, tranche, amountUsd, wallet: me });
      const steps = fromPrepared(res.txs);
      review(
        ticker,
        `Subscribe ${usd(res.amountUsd)} to ${tranche === "senior" ? "Senior" : "Junior"}`,
        steps,
        splitList([
          ["Book", esc(ticker)],
          ["Tranche", tranche === "senior" ? "Senior" : "Junior"],
          ["Amount", usd(res.amountUsd)],
          ["Deposits", res.window.depositsOpen ? `Open (${esc(res.window.state)})` : "Closed"],
          ["Committed this round", usd(res.cap.committedUsd)],
          ["Room left under the cap", res.cap.remainingUsd === null ? (res.cap.sponsorExempt ? "Sponsor (exempt)" : "No cap") : usd(res.cap.remainingUsd)],
        ]) + notice("Your USDC stays in escrow until the first mark after the round end and cannot be cancelled before. Any excess above the caps is refundable when the round settles."),
        res.warnings,
      );
    },
  );
}

function redeemForm(args: Record<string, unknown>): void {
  const b = bookOf(args.bookId);
  if (!b) return host.notify("No book is open yet.", true);
  const t = asTranche(args.tranche);
  const heldBy = (wallet: string | null, tr: "senior" | "junior"): bigint | null => {
    const own = wallet && store.positionsOwner === wallet ? store.positions[b.bookId] : undefined;
    return own ? (positionView(own).rows.find((r) => r.tranche === tr)?.shares ?? null) : null;
  };
  const held = (tr: "senior" | "junior") => heldBy(host.wallet.snapshot.address, tr);
  const d = store.details[b.bookId];
  const notice7 = d?.charter?.juniorNoticeSeconds;
  const ticker = bookTicker(b.symbol, d?.charter?.ticker);
  const heldT = held(t);
  openForm(
    "redeem",
    ticker,
    "Request redemption",
    select("Tranche", "tranche", [
      ["senior", "Senior · first mark on or after the request"],
      ["junior", `Junior · ${notice7 != null ? duration(notice7) : "notice"} + next mark`],
    ], t, true) +
      amountField("Shares to redeem", "shares", heldT && heldT > 0n ? formatAmountInput(heldT, USDC_DECIMALS) : "") +
      `<div class="notice field full">Senior shares held: ${held("senior") == null ? "-" : formatAmountDisplay(held("senior"), USDC_DECIMALS, 4)}. Junior shares held: ${held("junior") == null ? "-" : formatAmountDisplay(held("junior"), USDC_DECIMALS, 4)}.<br>Shares still in escrow after a round must be claimed first. A request is always accepted, cannot be cancelled, and settles at the first mark on or after its eligible time at that mark's share price.</div>`,
    "Review request",
    async (v) => {
      const wallet = await requireWallet();
      const tranche = asTranche(v.tranche);
      const max = heldBy(wallet, tranche);
      const sharesStr = needAmount(v.shares ?? "", { max, symbol: "shares" });
      const res = await mutate("tranche.redeem", { bookId: b.bookId, tranche, shares: sharesStr, wallet });
      review(
        ticker,
        `Redeem ${formatAmountDisplay(apiAmount(res.shares), USDC_DECIMALS, 4)} ${tranche === "senior" ? "Senior" : "Junior"} shares`,
        fromPrepared(res.txs),
        splitList([
          ["Eligible after", esc(dateTime(res.eligibleAt))],
          ["Settles at the mark ending", esc(dateTime(res.settlesAtPeriodEnd))],
          ["Indicative value", `${usd(res.indicative.valueUsd)}<small>${esc(res.indicative.text)}</small>`],
        ]) + notice(esc(res.notice.text)),
      );
    },
  );
}

export async function claim(args: Record<string, unknown>): Promise<void> {
  try {
    const me = await requireWallet();
    const b = bookOf(args.bookId);
    if (!b) return;
    const res = await mutate("tranche.claim", { bookId: b.bookId, wallet: me });
    if (!res.txs.length) {
      host.notify([res.message, ...res.warnings].join(" "), res.warnings.length > 0);
      return;
    }
    const lines = res.claimable
      .filter((c) => Number(c.allocationShares) > 0 || Number(c.refundUsd) > 0 || Number(c.redemptionUsd) > 0 || Number(c.cancelledRefundUsd) > 0)
      .map((c) => [
        c.tranche === "senior" ? "Senior" : "Junior",
        [Number(c.allocationShares) > 0 ? `${formatAmountDisplay(apiAmount(c.allocationShares), USDC_DECIMALS, 4)} shares` : "", Number(c.refundUsd) > 0 ? `${usd(c.refundUsd)} refund` : "", Number(c.redemptionUsd) > 0 ? `${usd(c.redemptionUsd)} redeemed` : "", Number(c.cancelledRefundUsd) > 0 ? `${usd(c.cancelledRefundUsd)} cancelled-round refund` : ""]
          .filter(Boolean)
          .join(", "),
      ]) as Array<[string, string]>;
    review(bookTicker(b.symbol), "Claim", fromPrepared(res.txs), splitList(lines), res.warnings);
  } catch (e) {
    host.notify(e instanceof ApiError ? e.message : errText(e), true);
  }
}

export async function mint(): Promise<void> {
  try {
    const me = await requireWallet();
    const usdc = store.protocol?.usdc;
    if (!usdc) throw new Error("The USDC address is still being read; try again in a moment.");
    if (store.mintable !== true) throw new Error("The USDC this deployment uses is not mintable from a wallet.");
    review("TEST USDC", "Mint test USDC", [mintTestUsdcStep(usdc, me)], notice(`MockERC20.mint on ${esc(CHAIN.name)}. Test networks only; the token has no value.`));
  } catch (e) {
    host.notify(errText(e), true);
  }
}

function topUpForm(args: Record<string, unknown>): void {
  const b = bookOf(args.bookId);
  if (!b) return;
  const d = store.details[b.bookId];
  const maxWindow = store.maxTopUpWindow[b.bookId] ?? null;
  const ticker = bookTicker(b.symbol, d?.charter?.ticker);
  openForm(
    "topup",
    ticker,
    "Open a top-up round",
    field("Round window · hours", "hours", 24, "number", 'min="1" step="1" required', true) +
      amountField("Senior capacity · USDC", "senior", "50000", false) +
      amountField("Junior capacity · USDC", "junior", "25000", false) +
      `<div class="notice field full">Sponsor wallet only (${d?.charter ? esc(short(d.charter.sponsor)) : "see the charter"}); the transaction is simulated first and a non-sponsor wallet is refused before any prompt. The book must be Live with no round open.${maxWindow ? ` Longest window: ${esc(duration(maxWindow))}.` : ""} Commitments settle pro-rata up to these capacities at the first mark on or after the round end; Senior is also capped by the charter's Senior cap.</div>`,
    "Review round",
    async (v) => {
      await requireWallet();
      const hours = Number(v.hours);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("Enter a window in hours above zero.");
      const senior = parseAmount(v.senior ?? "", USDC_DECIMALS);
      const junior = parseAmount(v.junior ?? "", USDC_DECIMALS);
      if (senior === null || junior === null) throw new Error("Enter both capacities as USDC amounts (0 for none).");
      const step = openTopUpStep({ book: getAddress(b.components.book), windowSeconds: Math.round(hours * 3600), seniorCapacityUsd: senior, juniorCapacityUsd: junior, maxWindowSeconds: maxWindow });
      review(ticker, "Open a top-up round", [step], notice("Book.openTopUp. Opening a round lets allocators commit; it cannot be closed early."));
    },
  );
}

function charterFileForm(): void {
  const me = host.wallet.snapshot.address;
  openForm(
    "charterFile",
    "CHARTER",
    "File a market charter",
    field("Market symbol (venue)", "symbol", "PERP_NVDA_USDC", "text", 'maxlength="64" required') +
      field("Underlying ticker or index id", "underlying", "NVDA", "text", 'maxlength="64" required') +
      select("Underlying kind", "underlyingKind", [["ticker", "Canonical Stock Token ticker"], ["index", "Registered index"], ["token", "Stock Token address"]], "ticker") +
      select("Venue", "venue", [["orderly", "Orderly"], ["pool_engine", "In-house pool engine"]], "orderly") +
      select("Oracle", "oracle", [["attested", "Attested multi-source"], ["chainlink", "Chainlink"]], "attested") +
      select("Trading sessions", "sessions", [["24x5", "24 hours, 5 days"], ["24x7", "24 hours, 7 days"], ["nyse_rth", "NYSE regular hours"]], "24x5") +
      amountField("Insurance-fund size · USD", "ifTargetUsd", "30000", false) +
      amountField("MM inventory · USD", "mmInventoryUsd", "75000", false) +
      field("Senior hurdle share · bps", "seniorHurdleBps", 6000, "number", 'min="0" max="10000" required') +
      field("Senior capital cap · bps", "seniorCapBps", 7000, "number", 'min="0" max="10000" required') +
      field("Subscription window · hours", "subscriptionHours", 24, "number", 'min="0.02" step="0.01" required') +
      field("Junior notice · days", "juniorNoticeDays", 7, "number", 'min="0" step="0.01" required') +
      amountField("Per-wallet cap · USD (0 = none)", "perWalletCapUsd", "250000", false) +
      amountField("Max inventory · USD", "maxInventoryUsd", "50000", false) +
      field("Max skew · bps", "maxSkewBps", 25, "number", 'min="1" max="10000" required') +
      field("Minimum quote width · bps", "minQuoteWidthBps", 8, "number", 'min="1" required') +
      field("Max hedge leverage · ×", "maxHedgeLeverage", 1, "number", 'min="0" step="0.01" required') +
      field("Min hedge ratio · bps", "hedgeRatioMinBps", 5000, "number", 'min="0" max="65535" required') +
      field("Max hedge ratio · bps", "hedgeRatioMaxBps", 12000, "number", 'min="0" max="65535" required') +
      field("Drawdown kill · bps", "killAtDrawdownBps", -800, "number", 'min="-10000" max="-1" required') +
      select("Hedge venue", "hedgeVenue", [["UNIV3", "Uniswap v3"], ["UNIV4", "Uniswap v4"], ["ORDERLY", "Orderly"], ["ENGINE", "Pool engine"]], "UNIV3") +
      field("Hedge asset (ticker or address)", "hedgeAsset", "NVDA", "text", 'maxlength="66" required') +
      '<label class="check field full"><input type="checkbox" name="noNewRiskOffHours" checked>No new risk off-hours</label>' +
      `<div class="notice field full">Sponsor: ${me ? `<span class="hash">${esc(me)}</span>` : "the connected wallet"}. The draft is validated by the API and MarketCharter.validate before anything is signed; the review shows the flat charter fee, the sponsor bond and every transaction (USDC approval, $BKRN stake for the bond, filing).</div>`,
    "Validate & review",
    async (v) => {
      const sponsor = await requireWallet();
      const int = (k: string) => {
        const n = Number(v[k]);
        if (!Number.isFinite(n)) throw new Error(`${k}: enter a number.`);
        return Math.round(n);
      };
      const usdOf = (k: string) => {
        const s = normalizeAmount(v[k] ?? "", USDC_DECIMALS);
        if (s === null) throw new Error(`${k}: enter a USD amount.`);
        return s;
      };
      const kind = v.underlyingKind;
      const u = (v.underlying ?? "").trim();
      if (!u) throw new Error("Enter the underlying.");
      const underlying = kind === "token" ? (isAddress(u) ? { token: u } : null) : kind === "index" ? { index: u } : { ticker: u.toUpperCase() };
      if (!underlying) throw new Error("A Stock Token must be a 0x address.");
      const draft = {
        sponsor,
        underlying,
        venue: v.venue === "pool_engine" ? ("pool_engine" as const) : ("orderly" as const),
        oracle: v.oracle === "chainlink" ? ("chainlink" as const) : ("attested" as const),
        sessions: (["24x5", "24x7", "nyse_rth"].includes(v.sessions ?? "") ? v.sessions : "24x5") as "24x5" | "24x7" | "nyse_rth",
        ifTargetUsd: usdOf("ifTargetUsd"),
        mmInventoryUsd: usdOf("mmInventoryUsd"),
        mandate: {
          maxInventoryUsd: usdOf("maxInventoryUsd"),
          maxSkewBps: int("maxSkewBps"),
          minQuoteWidthBps: int("minQuoteWidthBps"),
          maxHedgeLeverage: Number(v.maxHedgeLeverage),
          hedgeRatioMinBps: int("hedgeRatioMinBps"),
          hedgeRatioMaxBps: int("hedgeRatioMaxBps"),
          noNewRiskOffHours: v.noNewRiskOffHours === "on",
          killAtDrawdownBps: int("killAtDrawdownBps"),
          hedgeAllow: [{ asset: (v.hedgeAsset ?? "").trim(), venue: (v.hedgeVenue ?? "UNIV3") as "UNIV3" | "UNIV4" | "ORDERLY" | "ENGINE" }],
        },
        seniorHurdleBps: int("seniorHurdleBps"),
        seniorCapBps: int("seniorCapBps"),
        subscriptionWindowSeconds: Math.round(Number(v.subscriptionHours) * 3600),
        juniorNoticeSeconds: Math.round(Number(v.juniorNoticeDays) * 86_400),
        perWalletCapUsd: usdOf("perWalletCapUsd"),
        symbol: (v.symbol ?? "").trim(),
      };
      const res = await mutate("charter.file", draft);
      if (!res.ok) throw new Error(res.issues.map((i) => i.message).join(" · ") || "The draft did not validate.");
      if (!res.txs.length) throw new Error(res.warnings.join(" ") || "No filing transaction could be prepared yet.");
      review(
        "CHARTER",
        `File ${esc(res.charter.symbol)}`,
        fromPrepared(res.txs),
        splitList([
          ["Underlying", esc(res.charter.ticker ?? res.charter.underlying)],
          ["Venue", esc(res.charter.venue)],
          ["Charter fee", res.fee ? `${usd(res.fee.charterFeeUsd)} (refunded on rejection)` : "-"],
          ["Sponsor bond", res.fee ? `${esc(res.fee.sponsorBondBkrn)} BKRN` : "-"],
          ["Validated by", [res.validatedBy.local ? "API" : "", res.validatedBy.chain ? "MarketCharter.validate" : "", res.validatedBy.charterService ? "charter service" : ""].filter(Boolean).join(", ")],
        ]),
        res.warnings,
      );
    },
  );
}

function charterVoteForm(args: Record<string, unknown>): void {
  const id = Number(args.charterId);
  const d = store.charterDetails[id];
  const c = (store.charters ?? []).find((x) => x.charterId === id);
  openForm(
    "charterVote",
    "COMMITTEE",
    `Committee review · ${esc(c?.symbol ?? `#${id}`)}`,
    select("Decision", "approve", [["true", "Approve"], ["false", "Reject"]], "true", true) +
      `<div class="notice field full">${d ? `Tally: ${d.tally.approvals} approve, ${d.tally.rejections} reject (approval needs ${d.tally.approveThreshold}, rejection ${d.tally.rejectThreshold}). Jury: ${d.jury ? `${esc(d.jury.cid)} · ${d.jury.recommendApprove ? "recommends approval" : "recommends rejection"}` : "not posted yet"}.<br>` : ""}Votes are RiskCommittee.vote transactions from a bonded committee member's wallet. The API checks the seat, the bond and a prior vote before preparing the transaction.</div>`,
    "Review vote",
    async (v) => {
      const member = await requireWallet();
      const res = await mutate("charter.decide", { charterId: id, member, approve: v.approve === "true" });
      review(
        "COMMITTEE",
        `${v.approve === "true" ? "Approve" : "Reject"} charter #${id}`,
        fromPrepared(res.txs),
        splitList([
          ["Current tally", `${res.tally.approvals} approve · ${res.tally.rejections} reject`],
          ["After your vote", `${res.projected.approvals} approve · ${res.projected.rejections} reject · ${esc(res.projected.outcome)}`],
          ["Jury", res.jury.posted ? esc(res.jury.cid) : "Not posted"],
        ]),
        res.warnings,
      );
    },
  );
}

function agentRegisterForm(args: Record<string, unknown>): void {
  const b = bookOf(args.bookId);
  if (!b) return;
  const d = store.details[b.bookId];
  const me = host.wallet.snapshot.address ?? "";
  const ticker = bookTicker(b.symbol, d?.charter?.ticker);
  const tier = d?.mandate?.maxInventoryUsd ? normalizeAmount(d.mandate.maxInventoryUsd) ?? "" : "";
  openForm(
    "agentRegister",
    ticker,
    "Register a bookrunner desk key",
    field("Desk key address (public)", "key", "", "text", 'pattern="0x[0-9a-fA-F]{40}" maxlength="42" required autocomplete="off"', true) +
      field("Operator address", "operator", me, "text", 'pattern="0x[0-9a-fA-F]{40}" maxlength="42" required autocomplete="off"', true) +
      field("Valid for · days", "days", 365, "number", 'min="1" step="1" required') +
      amountField("Inventory tier · USD", "tier", tier, false) +
      `<div class="notice field full">The tier must be at least the mandate's maximum inventory${d?.mandate ? ` (${usd(d.mandate.maxInventoryUsd)})` : ""}, and the operator must have enough free $BKRN stake to bond it. The sponsor signs registerKey; a third-party operator first signs consentKey from its own wallet. Enter public addresses only: never a private key.</div>`,
    "Review registration",
    async (v) => {
      await requireWallet();
      const key = (v.key ?? "").trim();
      const operator = (v.operator ?? "").trim();
      if (!isAddress(key)) throw new Error("The desk key must be a 0x address (its public address, never a private key).");
      if (!isAddress(operator)) throw new Error("The operator must be a 0x address.");
      const days = Number(v.days);
      if (!Number.isFinite(days) || days <= 0) throw new Error("Enter a validity in days above zero.");
      const tierUsd = normalizeAmount(v.tier ?? "", USDC_DECIMALS);
      if (!tierUsd) throw new Error("Enter the inventory tier in USD.");
      const validUntil = Math.floor(Date.now() / 1000) + Math.round(days * 86_400);
      const res = await mutate("agent.register", { bookId: b.bookId, key, operator, validUntil, inventoryTierUsd: tierUsd });
      review(
        ticker,
        "Register desk key",
        fromPrepared(res.txs),
        splitList([
          ["Desk key", `<span class="hash">${esc(res.key)}</span>`],
          ["Operator", `<span class="hash">${esc(res.operator)}</span>`],
          ["Valid until", esc(date(res.validUntil))],
          ["Inventory tier", usd(res.inventoryTierUsd)],
          ["Operator bond required", res.requiredBondBkrn ? `${esc(res.requiredBondBkrn)} BKRN` : "-"],
          ["Sponsor (signs registerKey)", res.signer ? `<span class="hash">${esc(res.signer)}</span>` : "-"],
        ]),
        res.warnings,
      );
    },
  );
}

function agentRevokeForm(args: Record<string, unknown>): void {
  const b = bookOf(args.bookId);
  if (!b) return;
  const key = String(args.key ?? "");
  const ticker = bookTicker(b.symbol);
  openForm(
    "agentRevoke",
    ticker,
    "Revoke a desk key",
    `<p class="field full"><span class="hash">${esc(key)}</span></p>` +
      field("Reason (up to 32 bytes)", "reason", "REVOKED", "text", 'maxlength="32" required', true) +
      '<div class="notice field full">MMMandate.revokeKey takes effect in the same block. Allowed signers: the sponsor, the risk service, the committee or the key itself; the simulation refuses any other wallet before a prompt.</div>',
    "Review revocation",
    async (v) => {
      await requireWallet();
      const reason = (v.reason ?? "").trim() || "REVOKED";
      if (stringToBytes(reason).length > 32) throw new Error("The reason must fit in 32 bytes.");
      if (!isAddress(key)) throw new Error("Unknown key.");
      const res = await mutate("agent.revoke", { bookId: b.bookId, key, reason });
      review(ticker, "Revoke desk key", fromPrepared(res.txs), splitList([["Key", `<span class="hash">${esc(res.key)}</span>`], ["Reason", esc(res.reason)]]), res.warnings);
    },
  );
}

function stakeForm(): void {
  const me = host.wallet.snapshot.address;
  const bal = me && store.balancesOwner === me ? (store.balances?.bkrn ?? null) : null;
  openForm(
    "stake",
    "$BKRN",
    "Stake $BKRN",
    amountField("Amount · $BKRN", "amount", bal && bal > 0n ? formatAmountInput(bal, BKRN_DECIMALS, 2) : "") +
      `<div class="notice field full">Wallet: ${bal == null ? "-" : `${formatAmountDisplay(bal, BKRN_DECIMALS)} BKRN`}. Stake backs sponsor bonds, committee seats and operator tiers, and shares the $BKRN bought back with protocol carry. Unstaking waits out the cooldown${store.stakingProtocol?.cooldownSec != null ? ` (${esc(duration(store.stakingProtocol.cooldownSec))})` : ""}. The approval covers this amount only.</div>`,
    "Review stake",
    async (v) => {
      const wallet = await requireWallet();
      const p = store.protocol;
      if (!p) throw new Error("Contract addresses are still being read; try again in a moment.");
      const amountStr = needAmount(v.amount ?? "", { decimals: BKRN_DECIMALS, balance: store.balancesOwner === wallet ? (store.balances?.bkrn ?? null) : null, symbol: "BKRN" });
      const amount = parseAmount(amountStr, BKRN_DECIMALS) as bigint;
      const allowance = store.stakeOwner === wallet ? (store.stakePosition?.allowance ?? null) : null;
      review("$BKRN", "Stake $BKRN", stakeSteps({ bkrn: p.bkrn, staking: p.staking, amount, allowance }), notice("BkrnStaking.stake on " + esc(CHAIN.name) + "."));
    },
  );
}

function unstakeForm(): void {
  const pos = store.stakePosition;
  openForm(
    "unstake",
    "$BKRN",
    "Request an unstake",
    amountField("Amount · $BKRN", "amount", pos && pos.available > 0n ? formatAmountInput(pos.available, BKRN_DECIMALS, 2) : "") +
      `<div class="notice field full">Free to unstake: ${pos ? `${formatAmountDisplay(pos.available, BKRN_DECIMALS)} BKRN` : "-"}. Locked bonds cannot be unstaked. A new request restarts the cooldown for everything already pending.</div>`,
    "Review request",
    async (v) => {
      const wallet = await requireWallet();
      const p = store.protocol;
      const sp = store.stakeOwner === wallet ? store.stakePosition : null;
      if (!p || !sp) throw new Error("Your stake is still being read; try again in a moment.");
      const amountStr = needAmount(v.amount ?? "", { decimals: BKRN_DECIMALS, max: sp.available, symbol: "BKRN" });
      const amount = parseAmount(amountStr, BKRN_DECIMALS) as bigint;
      review("$BKRN", "Request an unstake", [requestUnstakeStep({ staking: p.staking, amount, available: sp.available, pending: sp.pending, cooldownSec: store.stakingProtocol?.cooldownSec ?? null })], "");
    },
  );
}

export async function stakingAction(kind: "cancelUnstake" | "withdrawUnstaked" | "claimReward"): Promise<void> {
  try {
    const wallet = await requireWallet();
    const p = store.protocol;
    const sp = store.stakeOwner === wallet ? store.stakePosition : null;
    if (!p || !sp) throw new Error("Your stake is still being read; try again in a moment.");
    const step = kind === "cancelUnstake" ? cancelUnstakeStep(p.staking, sp.pending) : kind === "withdrawUnstaked" ? withdrawUnstakedStep(p.staking, sp.pending) : claimRewardStep(p.staking, sp.earned);
    review("$BKRN", kind === "cancelUnstake" ? "Cancel the unstake request" : kind === "withdrawUnstaked" ? "Withdraw unstaked $BKRN" : "Claim distributions", [step], "");
  } catch (e) {
    host.notify(errText(e), true);
  }
}

// ------------------------------------------------------------------ marks
export async function verifyMark(markId: number): Promise<void> {
  try {
    const r = await query("receipts.root", { markId });
    if (r.kind !== "mark") throw new Error("Unexpected answer.");
    shell(
      "VERIFIED RECORD",
      r.matches ? "Receipts root matches" : "Receipts root differs",
      `<p>${r.matches ? "The root recomputed from the indexed hourly receipt roots equals the root committed with this mark." : "The root recomputed from the indexed hourly roots does not equal the committed root. The indexer may be missing an hour; the committed root on-chain is authoritative."}</p>${splitList([
        ["Mark", `#${r.markId}`],
        ["Book", esc(bookTicker((store.books ?? []).find((x) => x.bookId === r.bookId)?.symbol ?? `#${r.bookId}`))],
        ["Period", `${esc(dateTime(r.periodStart))} to ${esc(dateTime(r.periodEnd))}`],
        ["Receipt roots in the period", String(r.hours.length)],
        ["Receipt leaves", String(r.hours.reduce((a, h) => a + h.leafCount, 0))],
      ])}<div class="hash">Committed: ${esc(r.receiptsRoot)}<br>Recomputed: ${esc(r.computedRoot)}<br>Inventory root: ${esc(r.inventoryRoot)}</div>`,
    );
  } catch (e) {
    host.notify(e instanceof ApiError ? e.message : errText(e), true);
  }
}

export function exportMark(bookId: number, markId: number): void {
  const m = (store.marks[bookId] ?? []).find((x) => x.markId === markId);
  if (!m) return;
  const blob = new Blob([JSON.stringify({ ...m, row: markRow(m) }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bookrunner-book${bookId}-mark${markId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
