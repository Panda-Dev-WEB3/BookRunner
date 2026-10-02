// Invest panel at the top of a book's page (/books/:bookId): deposit into Senior or Junior of this
// book during an open subscription window or top-up round (1 choose a tranche, 2 amount, 3 review
// and sign), or withdraw and collect from the Withdraw tab. ?tranche=senior|junior preselects a
// tranche and ?tab=withdraw opens the Withdraw tab.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { getAddress } from "viem";
import { POLL, trpc } from "../../api/trpc";
import { AmountStep, ReviewStep } from "../../components/invest/DepositFlow";
import { type FlowStep, StepTrail, WindowBadge } from "../../components/invest/InvestBits";
import { killedDepositNote, windowSentence } from "../../components/invest/investCopy";
import {
  type DepositWindow,
  type RoundRoom,
  TRANCHE_NAME,
  type TrancheId,
  type TrancheRoom,
  bookRooms,
  depositWindow,
  positionFlags,
  seniorRoundRoom,
} from "../../components/invest/logic";
import { TrancheChoice } from "../../components/invest/TrancheChoice";
import { useProtocolParams, useTrancheRounds } from "../../components/invest/useInvestChain";
import { WithdrawPanel } from "../../components/invest/WithdrawPanel";
import { IconArrowRight } from "../../components/icons";
import { Badge, Callout, Card, Tabs } from "../../components/ui";
import type { BookDetail } from "../../lib/api-types";
import { venueLabel } from "../../lib/copy";
import { isoToSec, tickerOf, usdRaw } from "../../lib/format";
import { nextMarkLabel } from "../../lib/lowgas";
import type { TopUpRound } from "../../lib/topup";
import { useTopUpRounds } from "../../wallet/topUp";
import { useWallet } from "../../wallet/WalletContext";

type Tab = "deposit" | "withdraw";
const ZERO = "0x0000000000000000000000000000000000000000";

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Senior room left under the Senior cap for this top-up round (estimate): the cap room at the last
 * marked NAVs, counting the Junior committed so far (up to its capacity), minus the Senior already
 * committed. null outside a top-up round or when the inputs are unknown.
 */
function seniorRoomLeft(book: BookDetail, w: DepositWindow, rooms: Record<TrancheId, RoundRoom | null>): bigint | null {
  const s = usdRaw(book.seniorNavUsd);
  const j = usdRaw(book.juniorNavUsd);
  if (!book.charter || s === null || j === null || !rooms.senior) return null;
  if (w.status === "closed" || w.status === "loading" || w.kind !== "topup") return null;
  return seniorRoundRoom({ seniorNav: s, juniorNav: j, capBps: book.charter.seniorCapBps, senior: rooms.senior, junior: rooms.junior });
}

/** Keyed by book so moving between books never carries a half-filled deposit across. */
export function InvestPanel(props: { book: BookDetail; now: number }) {
  return <BookInvest key={props.book.bookId} {...props} />;
}

function BookInvest({ book, now }: { book: BookDetail; now: number }) {
  const [search] = useSearchParams();
  const fromUrl = search.get("tranche");
  const [tab, setTab] = useState<Tab>(search.get("tab") === "withdraw" ? "withdraw" : "deposit");
  const [step, setStep] = useState<FlowStep>("tranche");
  const [tranche, setTranche] = useState<TrancheId | null>(fromUrl === "senior" || fromUrl === "junior" ? fromUrl : null);
  const [amount, setAmount] = useState("");
  const [round, setRound] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const shown = useRef(`${step}:${round}`);

  const w = useWallet();
  const me = w.active?.address ?? null;
  const nowSec = Math.floor(now / 1000);
  const ticker = tickerOf(book.symbol);
  const addrs = useMemo(
    () => ({ bookId: book.bookId, senior: getAddress(book.components.senior), junior: getAddress(book.components.junior) }),
    [book.bookId, book.components.senior, book.components.junior],
  );
  const addrList = useMemo(() => [addrs], [addrs]);
  const topUps = useTopUpRounds();
  const proto = useProtocolParams();
  const rounds = useTrancheRounds(addrList);
  const position = trpc.tranche.position.useQuery({ bookId: book.bookId, wallet: me ?? ZERO }, { enabled: !!me, refetchInterval: POLL.slow });

  const topUp: TopUpRound | null | undefined = book.state !== "Live" ? null : topUps.data ? (topUps.data[book.bookId] ?? null) : topUps.isError ? null : undefined;
  const base = {
    state: book.state,
    subscriptionEndsSec: isoToSec(book.subscriptionEnds),
    topUp,
    nowSec,
    markIntervalSec: book.markSchedule.intervalSeconds,
    guardianPaused: proto.data?.guardianPaused ?? null,
  };
  const bookWindow = depositWindow(base);
  const r = rounds.data?.[book.bookId];
  const windows: Record<TrancheId, DepositWindow> = {
    senior: depositWindow({ ...base, tranchePaused: r?.senior.paused ?? null }),
    junior: depositWindow({ ...base, tranchePaused: r?.junior.paused ?? null }),
  };
  const rooms: Record<TrancheId, TrancheRoom | null> = bookRooms({
    topUp,
    committed: { senior: r?.senior.totalCommitted, junior: r?.junior.totalCommitted },
    seniorNav: usdRaw(book.seniorNavUsd),
    juniorNav: usdRaw(book.juniorNavUsd),
    capBps: book.charter?.seniorCapBps,
  });
  const seniorRoom = seniorRoomLeft(book, bookWindow, rooms);

  const flags = position.data ? positionFlags(position.data.tranches) : null;
  const toCollect = !!flags && (flags.allocationToClaim || flags.redemptionToClaim);

  // Bring the step into view when it changes (not on first render).
  useEffect(() => {
    const at = `${step}:${round}`;
    if (shown.current === at) return;
    shown.current = at;
    const el = top.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 64 || r.top > window.innerHeight * 0.6) el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [step, round]);

  const go = (s: FlowStep) => setStep(s);
  const effectiveStep: FlowStep = step === "review" && !me ? "amount" : step;
  const ctx = tranche
    ? { book, ticker, addrs, tranche, window: windows[tranche], room: rooms[tranche], seniorRoom: tranche === "senior" ? seniorRoom : null }
    : null;
  const selectedOpen = tranche ? windows[tranche].status === "open" : false;

  const deposit = (
    <div className="space-y-5">
      {book.killed && (
        <Callout tone="warn" title="This book's mandate is killed">
          Quoting has stopped and the agent's keys are revoked; the Risk Committee may re-mandate the book.
          {killedDepositNote(bookWindow)} Withdrawals and claims are never blocked by a kill.
        </Callout>
      )}
      {bookWindow.status === "open" ? (
        <p className="max-w-3xl text-[14px] text-ink-2">{windowSentence(bookWindow)}</p>
      ) : (
        <Callout tone={bookWindow.status === "paused" || bookWindow.status === "settling" ? "warn" : "neutral"} title={bookWindow.status === "loading" ? "Checking the deposit round" : bookWindow.status === "paused" ? "Deposits are paused" : bookWindow.status === "settling" ? "This round has ended" : "Deposits are closed right now"}>
          {windowSentence(bookWindow)}
          {bookWindow.status !== "loading" ? " You can still compare the two tranches below." : ""}
        </Callout>
      )}

      <div ref={top} className="scroll-mt-24">
        <StepTrail step={effectiveStep} onGo={go} className="mb-5" />
        {effectiveStep === "tranche" && (
          <div className="space-y-4">
            <TrancheChoice book={book} params={proto.data} windows={windows} rooms={rooms} selected={tranche} onSelect={setTranche} />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-primary" disabled={!tranche || !selectedOpen} onClick={() => go("amount")}>
                {tranche ? `Continue with ${TRANCHE_NAME[tranche]}` : "Choose a tranche to continue"}
                <IconArrowRight size={15} />
              </button>
              {tranche && !selectedOpen && bookWindow.status !== "loading" && <span className="text-[12.5px] text-muted">Deposits into {TRANCHE_NAME[tranche]} are not open right now.</span>}
            </div>
          </div>
        )}
        {effectiveStep === "amount" && ctx && (
          <AmountStep {...ctx} amount={amount} onAmount={setAmount} onBack={() => go("tranche")} onReview={() => go("review")} />
        )}
        {effectiveStep === "review" && ctx && (
          <ReviewStep
            key={`${me}:${tranche}:${amount}:${round}`}
            {...ctx}
            amount={amount}
            onBack={() => go("amount")}
            onAnother={() => {
              setAmount("");
              setRound((n) => n + 1);
              go("amount");
            }}
            onWithdrawTab={() => setTab("withdraw")}
          />
        )}
      </div>
    </div>
  );

  return (
    <Card id="invest" as="section" padding="lg" className="mb-5 scroll-mt-20" aria-label={`Invest in ${ticker}`}>
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="eyebrow mb-1.5 !text-accent-text">Invest</div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] sm:text-[26px]">Invest in {ticker}</h2>
          <p className="mt-1.5 max-w-2xl text-[14px] text-ink-2">
            This book underwrites the {ticker} perp market ({venueLabel(book.venue)}). Choose Senior or Junior, enter an amount and review it; nothing is sent until you sign in your wallet.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end">
          <WindowBadge w={bookWindow} nowSec={nowSec} />
          {(book.state === "Live" || book.state === "Retiring") && <span className="text-[12px] text-muted">Next mark {nextMarkLabel(book.markSchedule, now)}</span>}
        </div>
      </div>
      <Tabs<Tab>
        keepMounted
        ariaLabel={`Invest in ${ticker}`}
        value={tab}
        onChange={setTab}
        items={[
          { id: "deposit", label: "Deposit", content: deposit },
          {
            id: "withdraw",
            label: "Withdraw",
            badge: toCollect ? (
              <Badge size="sm" tone="good" dot>
                Ready to collect
              </Badge>
            ) : flags?.hasShares ? (
              <Badge size="sm" tone="neutral">
                Invested
              </Badge>
            ) : undefined,
            content: <WithdrawPanel book={book} ticker={ticker} addrs={addrs} wallet={me} position={position} onDepositTab={() => setTab("deposit")} />,
          },
        ]}
      />
    </Card>
  );
}
