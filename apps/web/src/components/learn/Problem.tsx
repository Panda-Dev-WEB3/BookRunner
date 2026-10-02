// 1. The problem: a new perp market needs capital and risk-taking behind it, and today one party carries
// it alone. Diagram: allocators -> book (Senior / Junior) -> market, fee flow back into the book.
import { Term } from "../Term";
import { IconLayers, IconShield, IconSpark } from "../icons";
import { Card } from "../ui";
import { Figure, FlowArrow, FlowNode, LearnSection, Prose } from "./parts";

const NEEDS = [
  {
    icon: IconShield,
    title: "An insurance fund",
    body: "Absorbs trader losses a liquidation could not cover, so one bad position does not spill onto everyone else in the market.",
    term: "insuranceFund" as const,
  },
  {
    icon: IconLayers,
    title: "Market-making inventory",
    body: "The capital a market maker quotes with: a price to buy and a price to sell, on both sides, all day.",
    term: "marketMaker" as const,
  },
  {
    icon: IconSpark,
    title: "Someone to quote it",
    body: "A market maker that keeps fair quotes, hedges what it ends up holding and stays inside clear limits.",
    term: "bookrunnerAgent" as const,
  },
];

export function ProblemSection(props: { index: number }) {
  return (
    <LearnSection
      id="problem"
      index={props.index}
      eyebrow="The problem"
      title="New markets need a house, and nobody wants to be it alone"
      lead={
        <>
          A <Term id="perp">perp</Term> market lets traders go long or short a price with margin. Before it can trade well, someone has to put money behind it
          and take the risk that comes with it.
        </>
      }
    >
      <ul className="grid gap-4 sm:grid-cols-3">
        {NEEDS.map((n) => (
          <Card as="li" key={n.title} padding="md">
            <span className="inline-flex size-9 items-center justify-center rounded-control bg-accent-soft text-accent-text">
              <n.icon size={18} />
            </span>
            <h3 className="mt-3 text-[15px] font-semibold text-ink">{n.title}</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{n.body}</p>
            <p className="mt-2 text-[12.5px] text-muted">
              Term: <Term id={n.term} />
            </p>
          </Card>
        ))}
      </ul>

      <Prose className="mt-8">
        <p>
          Today that seat usually goes to a single party. On venues such as Orderly, whoever lists a market funds its insurance fund and keeps a share of its
          taker fees, and the seat is not shared. Shared house vaults exist elsewhere, but they blend every market into one pool: you cannot pick the market,
          and you cannot pick your place in the loss order.
        </p>
        <p>
          Bookrunner turns the seat into a syndicate, the way a bookrunner bank runs a deal. Each market gets its own <Term id="book">book</Term>. Many{" "}
          <Term id="allocator">allocators</Term> fund it together in two <Term id="tranche">tranches</Term>, and a bonded agent quotes it under a{" "}
          <Term id="mandate">mandate</Term> it cannot exceed. The book earns the market's <Term id="feeFlow">fee flow</Term>.
        </p>
      </Prose>

      <Figure
        className="mt-8"
        label="How a book connects allocators to one market"
        caption="One book per market. Allocators fund it in USDC, the book funds the market's insurance fund first and then the market-making inventory, and the market's fees flow back into the book."
      >
        <div className="flex flex-col items-stretch sm:flex-row sm:items-center">
          <FlowNode title="Allocators" className="sm:w-[26%]">
            You and others deposit USDC and choose Senior or Junior.
          </FlowNode>
          <FlowArrow label="USDC" />
          <div className="min-w-0 rounded-control border border-line-strong bg-surface p-3 sm:w-[30%]">
            <div className="text-[13.5px] font-semibold text-ink">Book</div>
            <div className="mt-2 grid gap-1.5">
              <FlowNode series="senior" title="Senior" className="!p-2">
                Fixed share, loses last
              </FlowNode>
              <FlowNode series="junior" title="Junior" className="!p-2">
                Loses first, gets the residual
              </FlowNode>
            </div>
          </div>
          <FlowArrow label="funds" />
          <div className="min-w-0 rounded-control border border-line-strong bg-surface p-3 sm:flex-1">
            <div className="text-[13.5px] font-semibold text-ink">One perp market</div>
            <div className="mt-2 grid gap-1.5">
              <FlowNode tone="muted" title="Insurance fund" className="!p-2" />
              <FlowNode tone="muted" title="Market-making inventory" className="!p-2" />
              <FlowNode tone="accent" title="Bookrunner agent" className="!p-2">
                Quotes and hedges under the mandate
              </FlowNode>
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-control border border-fee/45 bg-fee/14 px-3 py-2.5">
          <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden className="shrink-0">
            <path d="M26 8H3m5-5L3 8l5 5" fill="none" stroke="var(--fee)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-[13px] text-ink-2">
            <span className="font-semibold text-fee-ink">Fee flow.</span> Traders pay fees to the market; the book's share comes back to the book and runs down
            the waterfall to Senior and Junior.
          </p>
        </div>
      </Figure>
    </LearnSection>
  );
}
