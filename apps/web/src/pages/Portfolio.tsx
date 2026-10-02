// Portfolio (/portfolio). Owned by the Portfolio page agent: positions, redemptions, claims.
import { PortfolioPlaceholder } from "../components/portfolio/PortfolioPlaceholder";
import { SetupChecklist } from "../components/SetupChecklist";
import { Section } from "../components/ui";

export function PortfolioPage() {
  return (
    <Section headingAs="h1" headerSize="md" eyebrow="Portfolio" title="Your portfolio" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <PortfolioPlaceholder />
      <SetupChecklist whenReady="hide" />
    </Section>
  );
}
