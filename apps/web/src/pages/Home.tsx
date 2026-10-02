// Home (/). Owned by the Home page agent: hero, what Bookrunner is, live books, setup checklist.
import { HomePlaceholder } from "../components/home/HomePlaceholder";
import { SetupChecklist } from "../components/SetupChecklist";
import { Section } from "../components/ui";

export function HomePage() {
  return (
    <>
      <Section
        tone="hero"
        space="lg"
        headingAs="h1"
        headerSize="xl"
        eyebrow="Bookrunner"
        title="Run the book."
        lead="The underwriting syndicate for on-chain perp markets."
      >
        <HomePlaceholder />
      </Section>
      <Section space="sm" container="prose">
        <SetupChecklist />
      </Section>
    </>
  );
}
