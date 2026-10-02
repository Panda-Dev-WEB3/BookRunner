// Invest (/invest). Owned by the Invest page agent: choose a book and a tranche, then deposit.
import { InvestPlaceholder } from "../components/invest/InvestPlaceholder";
import { SetupChecklist } from "../components/SetupChecklist";
import { Section } from "../components/ui";

export function InvestPage() {
  return (
    <Section headingAs="h1" headerSize="md" eyebrow="Invest" title="Invest in a book" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <InvestPlaceholder />
      <SetupChecklist />
    </Section>
  );
}
