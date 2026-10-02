// How it works (/learn). A didactic walk through Bookrunner in nine sections, each with a diagram or an
// interactive: the problem, a book's lifecycle, the tranches, a waterfall simulator, the mark, risk
// controls, low gas, BKRN and the glossary. Sticky table of contents with scroll spy (collapsed into a
// bar under the header below 1024px). Anchors: /learn#simulator, /learn#term-senior.
import { BkrnSection } from "../components/learn/BkrnSection";
import { GlossarySection } from "../components/learn/GlossarySection";
import { LearnIntro, LearnOutro } from "../components/learn/Intro";
import { LearnTocDesktop, LearnTocMobile } from "../components/learn/LearnToc";
import { LifecycleSection } from "../components/learn/Lifecycle";
import { LowGasSection } from "../components/learn/LowGasSection";
import { MarkSection } from "../components/learn/MarkSection";
import { useScrollSpy } from "../components/learn/parts";
import { ProblemSection } from "../components/learn/Problem";
import { RiskSection } from "../components/learn/RiskSection";
import { LEARN_SECTIONS } from "../components/learn/sections";
import { TranchesSection } from "../components/learn/Tranches";
import { SimulatorSection } from "../components/learn/WaterfallSimulator";
import { Container, Section } from "../components/ui";

const IDS = LEARN_SECTIONS.map((s) => s.id);

export function LearnPage() {
  const active = useScrollSpy(IDS);
  return (
    <>
      <Section
        tone="hero"
        space="md"
        headingAs="h1"
        headerSize="xl"
        eyebrow="How it works"
        title="How Bookrunner works"
        lead="Bookrunner lets many people fund one perp market together, in two tranches with a clear loss order, while a bonded agent quotes it under rules enforced in code. Nine short sections, plain words, and a simulator to play with."
      >
        <LearnIntro />
      </Section>
      <Container className="pb-16 sm:pb-24">
        <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="hidden pt-12 lg:block">
            <LearnTocDesktop activeId={active} />
          </aside>
          <div className="min-w-0">
            <LearnTocMobile activeId={active} />
            <div className="space-y-20 pt-10 sm:space-y-24 lg:pt-12">
              <ProblemSection index={0} />
              <LifecycleSection index={1} />
              <TranchesSection index={2} />
              <SimulatorSection index={3} />
              <MarkSection index={4} />
              <RiskSection index={5} />
              <LowGasSection index={6} />
              <BkrnSection index={7} />
              <GlossarySection index={8} />
            </div>
            <LearnOutro />
          </div>
        </div>
      </Container>
    </>
  );
}
