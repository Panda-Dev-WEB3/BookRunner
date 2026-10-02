// How it works (/learn). Owned by the Learn page agent: explainers, diagrams, glossary, FAQ.
import { LearnPlaceholder } from "../components/learn/LearnPlaceholder";
import { Section } from "../components/ui";

export function LearnPage() {
  return (
    <Section tone="hero" headingAs="h1" headerSize="lg" eyebrow="How it works" title="How Bookrunner works">
      <LearnPlaceholder />
    </Section>
  );
}
