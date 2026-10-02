// Stake (/stake). Owned by the Stake page agent: BKRN staking, the backstop, protocol carry.
import { SetupChecklist } from "../components/SetupChecklist";
import { StakePlaceholder } from "../components/stake/StakePlaceholder";
import { Section } from "../components/ui";

export function StakePage() {
  return (
    <Section headingAs="h1" headerSize="md" eyebrow="Stake" title="Stake BKRN" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <StakePlaceholder />
      <SetupChecklist whenReady="hide" />
    </Section>
  );
}
