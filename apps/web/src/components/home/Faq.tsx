// Home FAQ (accordion) with the testnet and risk notice. Answers come from faqContent.ts; this adds
// glossary terms, links and, for the NAV question, the live mark schedule from the API.
import { Link } from "react-router";
import { useNow } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import { config } from "../../lib/config";
import { LEGAL } from "../../lib/copy";
import { nextMarkLabel } from "../../lib/lowgas";
import { appChain } from "../../wallet/chains";
import { isTestChain } from "../../wallet/network";
import { IconArrowRight } from "../icons";
import { Accordion, type AccordionItem, Callout, Card, ExternalLink, Section, Term } from "../ui";
import { useMarkCadence, useProtocolTerms } from "../ProtocolTerms";
import { type FaqItem, faqItems } from "./faqContent";
import { summarizeBooks } from "./model";

export function Faq() {
  const terms = useProtocolTerms();
  const cadence = useMarkCadence();
  const items = faqItems({ testnet: isTestChain, chainName: appChain.name, chainId: appChain.id, carryPct: terms.carry, cadence });
  const accordion: AccordionItem[] = items.map((f) => ({ id: f.id, title: f.question, content: <FaqAnswer item={f} /> }));
  return (
    <Section id="faq" eyebrow="FAQ" title="Questions, answered" lead="Short answers to what people ask first. Every term with a dotted underline opens its definition." bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
      <Accordion items={accordion} headingLevel={3} defaultOpen={[items[0]?.id ?? ""]} />
      <div className="space-y-4 lg:sticky lg:top-24">
        <RiskNotice />
        <Card padding="md" title="Want the full picture?" description="The explainer walks through the waterfall, marks and every term in plain language.">
          <div className="flex flex-wrap gap-2">
            <Link to="/learn" className="btn btn-sm">
              How it works
              <IconArrowRight size={14} />
            </Link>
            <ExternalLink href={config.docsUrl} className="btn btn-sm btn-ghost">
              Docs
            </ExternalLink>
          </div>
        </Card>
      </div>
    </Section>
  );
}

function FaqAnswer({ item }: { item: FaqItem }) {
  return (
    <div className="space-y-3 leading-relaxed">
      {item.answer.map((p) => (
        <p key={p.slice(0, 32)}>{p}</p>
      ))}
      {item.id === "nav" && <LiveSchedule />}
      {((item.terms?.length ?? 0) > 0 || (item.links?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-[13px]">
          {item.terms && item.terms.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-muted">Terms:</span>
              {item.terms.map((t) => (
                <Term key={t} id={t} />
              ))}
            </span>
          )}
          {item.links?.map((l) => (
            <Link key={l.to} to={l.to} className="link inline-flex items-center gap-1">
              {l.label}
              <IconArrowRight size={13} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveSchedule() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.list });
  const now = useNow(5_000);
  const next = q.data ? summarizeBooks(q.data).nextMark : null;
  if (!next) return null;
  return (
    <p className="rounded-control border border-line bg-surface-2 px-3 py-2 text-[13px]">
      <span className="font-medium text-ink">On {appChain.name} right now:</span> {next.cadence} marks, the next one {nextMarkLabel(next, now)}.
    </p>
  );
}

function RiskNotice() {
  return (
    <Callout tone="risk" title={isTestChain ? "Testnet and risk notice" : "Risk notice"}>
      <div className="space-y-2">
        {isTestChain && (
          <p>
            {appChain.name} is a test network. Test ETH and test USDC have no value, and nothing here is an offer or advice.
          </p>
        )}
        <p>With real funds, a deposit can lose value. Junior takes losses first; Senior is last loss, not no loss. Fee flow in past periods says nothing about the next one.</p>
        <p className="text-[12.5px]">{LEGAL}</p>
      </div>
    </Callout>
  );
}
