// Opening and closing of the How it works page: the short version in three steps, and where to go next
// (with the risk and testnet notice wherever money is involved).
import { Link } from "react-router";
import { isTestKind } from "../../lib/chainConfig";
import { config } from "../../lib/config";
import { IconArrowRight, IconBook } from "../icons";
import { Term } from "../Term";
import { Callout, Card } from "../ui";
import { AnchorLink } from "./parts";

const SHORT_VERSION = [
  {
    n: 1,
    title: "A sponsor charters a market",
    body: (
      <>
        They file its terms and post a bond. The <Term id="riskCommittee" /> approves it 2-of-3, and it becomes a <Term id="book">book</Term>.
      </>
    ),
  },
  {
    n: 2,
    title: "Allocators fund it in two tranches",
    body: (
      <>
        <Term id="senior">Senior</Term> gets a fixed share of the fee flow and loses last. <Term id="junior">Junior</Term> takes losses first and gets the residual.
      </>
    ),
  },
  {
    n: 3,
    title: "An agent runs it inside a mandate",
    body: (
      <>
        Fees flow down the <Term id="waterfall">waterfall</Term> and a signed <Term id="mark">mark</Term> records the book's value every period.
      </>
    ),
  },
];

export function LearnIntro() {
  const testnet = isTestKind(config.chain.kind);
  return (
    <>
      <h2 className="eyebrow mb-3">The short version</h2>
      <ol className="grid gap-3 md:grid-cols-3">
        {SHORT_VERSION.map((s) => (
          <Card as="li" key={s.n} padding="md" className="relative">
            <span className="tnum inline-flex size-7 items-center justify-center rounded-full bg-accent text-[12.5px] font-semibold text-accent-ink" aria-hidden>
              {s.n}
            </span>
            <h3 className="mt-3 text-[15px] font-semibold text-ink">{s.title}</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
          </Card>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <AnchorLink to="simulator" className="btn btn-primary btn-lg">
          Try the waterfall simulator <IconArrowRight size={16} />
        </AnchorLink>
        <AnchorLink to="glossary" className="btn btn-lg">
          <IconBook size={16} /> Jump to the glossary
        </AnchorLink>
      </div>
      {testnet && (
        <p className="mt-4 text-[12.5px] text-muted">
          Live figures on this page come from Bookrunner on {config.chain.name}. Test tokens have no value; <Term id="testnet">what is a testnet?</Term>
        </p>
      )}
    </>
  );
}

export function LearnOutro() {
  return (
    <div className="mt-20 border-t border-line pt-12">
      <Card padding="lg" tone="accent">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink sm:text-[26px]">Ready to look at a real book?</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">
          Every live book shows its NAV, its mandate, its marks and their receipts. You can browse without a wallet, and connect one when you want to fund a
          tranche.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link to="/invest" className="btn btn-primary btn-lg">
            See the books <IconArrowRight size={16} />
          </Link>
          <Link to="/books" className="btn btn-lg">
            Protocol view
          </Link>
        </div>
      </Card>
      <Callout tone="risk" className="mt-5" title="Funding a book can lose money">
        Junior absorbs losses first, and Senior can lose too once Junior and the backstop pool are used up. Nothing on this page is a forecast or advice.
        {isTestKind(config.chain.kind) ? " Bookrunner currently runs on a testnet, where tokens have no value." : ""}
      </Callout>
    </div>
  );
}
