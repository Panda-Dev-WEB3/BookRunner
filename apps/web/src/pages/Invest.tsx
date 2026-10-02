// Invest (/invest): how investing works in three steps, every book with its live deposit round
// (state, marked NAV, Senior / Junior share prices, room left per tranche, per-wallet cap) and a way
// into each book's invest panel; the setup checklist until the wallet is ready; Senior vs Junior
// explained with the waterfall diagrams; common questions; the risk notice.
import { useMemo } from "react";
import { Link } from "react-router";
import { useNow, useQueryError } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { BookInvestCard } from "../components/invest/BookInvestCard";
import { RiskNotice } from "../components/invest/InvestBits";
import { INVEST_STEPS } from "../components/invest/investCopy";
import { pctOfBps } from "../components/invest/logic";
import { FeesNote } from "../components/invest/TrancheChoice";
import { useProtocolParams, useTrancheRounds } from "../components/invest/useInvestChain";
import { FeeFlowDiagram, LossOrderDiagram } from "../components/invest/WaterfallDiagram";
import { IconArrowRight } from "../components/icons";
import { SetupChecklist } from "../components/SetupChecklist";
import { Accordion, Card, EmptyState, ErrorState, Section, Skeleton, Term, TrancheBadge, cx } from "../components/ui";
import { termAnchor } from "../lib/glossary";
import { cadenceTitle } from "../lib/lowgas";
import { appChain } from "../wallet/chains";
import { useTopUpRounds } from "../wallet/topUp";
import { useOnboarding } from "../wallet/useOnboarding";
import { useWallet } from "../wallet/WalletContext";

export function InvestPage() {
  const list = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.slow });
  const listError = useQueryError(list);
  const topUps = useTopUpRounds();
  const proto = useProtocolParams();
  const now = useNow(15_000);
  const books = useMemo(() => (list.data ?? []).map((b) => ({ bookId: b.bookId, senior: b.components.senior, junior: b.components.junior })), [list.data]);
  const rounds = useTrancheRounds(books);
  const w = useWallet();
  const ob = useOnboarding();
  const carry = proto.data?.carryBps != null ? pctOfBps(proto.data.carryBps) : null;
  const cadence = list.data?.[0]?.markSchedule.cadence ?? null;
  const cadenceLine = `Live data from ${appChain.name}${cadence ? ` · ${cadenceTitle(cadence).toLowerCase()}` : ""}`;

  const faq = [
    {
      id: "when",
      title: "When do I get my shares?",
      content: (
        <p>
          A deposit made during a <Term id="topUpRound">top-up round</Term> waits in the tranche's escrow. At the first <Term id="mark">mark</Term> after the round ends, the round settles at that
          mark's share price and you collect your shares, and any refund, from the book's Withdraw tab. In a new book's <Term id="subscriptionWindow">subscription window</Term>, shares start at
          1.00 USDC each when the window closes.
        </p>
      ),
    },
    {
      id: "over",
      title: "What if more USDC is committed than a round can take?",
      content: (
        <p>
          Each tranche has a capacity for the round, and Senior must also stay under the book's Senior cap. If commitments exceed the room, every deposit is accepted pro-rata and the rest is
          refunded in USDC when you collect.
        </p>
      ),
    },
    {
      id: "cancel",
      title: "Can I cancel a deposit?",
      content: (
        <p>
          No. A deposit cannot be cancelled or withdrawn before its round settles at the first <Term id="mark">mark</Term> after the round ends; rounds cannot be closed early, so the USDC stays in
          escrow until then. Withdrawals apply to shares after settlement. If the book retires first, the round is cancelled and every deposit is refunded in full.
        </p>
      ),
    },
    {
      id: "withdraw",
      title: "Can I withdraw at any time?",
      content: (
        <p>
          Once you hold shares, you can ask at any time, and the request is always accepted: <Term id="redemptionNotice">notice is not a gate</Term>. Senior settles at the next mark. Junior settles at the first mark
          after its notice period, which each book sets in its charter. You receive the share price of the mark that settles your request, which can be higher or lower than today's.
        </p>
      ),
    },
    {
      id: "cost",
      title: "What does it cost?",
      content: (
        <p>
          There is no deposit, withdrawal or management fee; you pay network <Term id="gas">gas</Term> for each transaction. Inside the book, capped expenses and the protocol{" "}
          <Term id="carry">carry</Term>
          {carry ? ` (${carry})` : ""} come off the fee flow before Senior and Junior are paid.
        </p>
      ),
    },
    {
      id: "wrong",
      title: "What can go wrong?",
      content: (
        <p>
          A book can lose money: its <Term id="marketMaker">market maker</Term> can lose on inventory or hedges, and trader losses that a liquidation could not cover fall on the{" "}
          <Term id="insuranceFund">insurance fund</Term>. Losses hit Junior first, then Senior; the <Term id="backstop">backstop</Term> may cover Senior only up to what its pool holds. If the
          drawdown reaches the mandate's limit, the <Term id="killSwitch">kill switch</Term> stops quoting.
        </p>
      ),
    },
    {
      id: "testnet",
      title: "Why a test network?",
      content: (
        <p>
          Bookrunner runs on <Term id="testnet">Robinhood Chain Testnet</Term> today. Test ETH and test USDC have no value, so you can try every step, from connecting a wallet to collecting
          shares, without risking anything.
        </p>
      ),
    },
  ];

  return (
    <>
      <Section
        tone="hero"
        space="md"
        headingAs="h1"
        headerSize="lg"
        eyebrow="Invest"
        title="Underwrite a market's book"
        lead="Each book funds one perp market's insurance fund and market-making inventory, and receives that market's fee flow. Pick a book, choose Senior or Junior, and deposit USDC while a deposit round is open."
      >
        <ol className="grid gap-3 sm:grid-cols-3">
          {INVEST_STEPS.map((s) => (
            <li key={s.n} className="flex gap-3 rounded-card border border-line bg-surface/80 p-4 shadow-card">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text tnum" aria-hidden>
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="text-[14.5px] font-semibold">
                  <span className="sr-only">Step {s.n}: </span>
                  {s.title}
                </div>
                <p className="mt-1 text-[13px] text-ink-2">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section space="sm" className="pb-12 sm:pb-16" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div id="books" className="min-w-0 scroll-mt-24 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Books</h2>
            <span className="text-[12.5px] text-muted">{cadenceLine}</span>
          </div>
          {list.data === undefined ? (
            listError ? (
              <ErrorState error={listError} onRetry={() => list.refetch()} />
            ) : (
              <div className="space-y-4" aria-busy="true" aria-label="Loading books">
                {[0, 1].map((i) => (
                  <Card key={i} padding="lg">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="mt-4 h-16 w-full" />
                    <Skeleton className="mt-4 h-24 w-full" />
                  </Card>
                ))}
              </div>
            )
          ) : list.data.length === 0 ? (
            <EmptyState
              title="No books yet"
              body="A book appears here once the Risk Committee approves its charter. Sponsors file charters from the protocol pages."
              action={
                <Link className="btn btn-sm" to="/charters">
                  See charters
                </Link>
              }
            />
          ) : (
            list.data.map((b) => (
              <BookInvestCard
                key={b.bookId}
                item={b}
                topUp={topUps.data ? (topUps.data[b.bookId] ?? null) : topUps.isError ? null : undefined}
                rounds={rounds.data?.[b.bookId]}
                guardianPaused={proto.data?.guardianPaused ?? null}
                now={now}
              />
            ))
          )}
        </div>

        <aside className={cx("min-w-0 space-y-4", w.active && !ob.ready && "order-first lg:order-none")} aria-label="Before you invest">
          <SetupChecklist
            id="setup"
            compact
            readyAction={
              <a className="btn btn-primary btn-sm" href="#books">
                Choose a book
                <IconArrowRight size={14} />
              </a>
            }
          />
          <RiskNotice compact />
        </aside>
      </Section>

      <Section
        tone="muted"
        eyebrow="Two ways in"
        title="Senior or Junior?"
        lead="Both tranches of a book hold the same assets. They differ in who is paid first and who absorbs losses first."
        headerSize="md"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card padding="lg">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <TrancheBadge tranche="senior" term />
              <span className="text-[13px] text-ink-2">paid first, last loss</span>
            </div>
            <p className="text-[14px] text-ink-2">
              Senior receives its <Term id="hurdle">share</Term> of each distribution before Junior. Losses reach Senior only after all of Junior is used up. Senior is last loss, not no loss.
            </p>
          </Card>
          <Card padding="lg">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <TrancheBadge tranche="junior" term />
              <span className="text-[13px] text-ink-2">first loss, residual</span>
            </div>
            <p className="text-[14px] text-ink-2">
              Junior keeps what is left of each distribution after Senior's share, and absorbs losses first. The sponsor holds at least 10% of Junior when the subscription window closes, so it shares the first losses too; later top-ups can dilute that share.
            </p>
          </Card>
          <Card padding="lg" as="section" aria-label="Fee flow pays down">
            <figure className="m-0 min-w-0">
              <figcaption className="mb-3 text-[14.5px] font-semibold">Fee flow pays down</figcaption>
              <FeeFlowDiagram carryPct={carry} className="mx-auto block max-w-[360px]" />
            </figure>
          </Card>
          <Card padding="lg" as="section" aria-label="Losses climb up">
            <figure className="m-0 min-w-0">
              <figcaption className="mb-3 text-[14.5px] font-semibold">Losses climb up</figcaption>
              <LossOrderDiagram className="mx-auto block max-w-[360px]" />
            </figure>
          </Card>
        </div>
        <FeesNote params={proto.data} />
        <Link className="link mt-4 inline-flex items-center gap-1 text-[13.5px]" to={`/learn#${termAnchor("waterfall")}`}>
          More on the waterfall
          <IconArrowRight size={13} />
        </Link>
      </Section>

      <Section title="Common questions" headerSize="md" container="prose">
        <Accordion items={faq} headingLevel={3} />
      </Section>
    </>
  );
}
