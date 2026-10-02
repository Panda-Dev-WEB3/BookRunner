// Stake (/stake): BKRN staking. Live protocol figures, the connected wallet's stake, and the
// stake / unstake / claim flows (calldata built in the browser, signed through TxRunner), followed
// by plain-language explainers: where staked BKRN's share comes from (carry -> buyback), how the
// unstake cooldown works, and what can go wrong. Facts follow BkrnStaking, BkrnFeeRouter, Backstop.
import { CarryFlow } from "../components/stake/CarryFlow";
import { CooldownTimeline } from "../components/stake/CooldownTimeline";
import { StakeActions } from "../components/stake/StakeActions";
import { StakeAside } from "../components/stake/StakeAside";
import { StakeFaq } from "../components/stake/StakeFaq";
import { StakeOverview } from "../components/stake/StakeOverview";
import { StakePosition } from "../components/stake/StakePosition";
import { StakeRisks } from "../components/stake/StakeRisks";
import { stakeSetupDone } from "../components/stake/stakeLogic";
import { useStakePosition, useStakingProtocol } from "../components/stake/useStaking";
import { SetupChecklist } from "../components/SetupChecklist";
import { Callout, Section, Term } from "../components/ui";
import { buybackWhere } from "../lib/copy";
import { isTestChain } from "../wallet/network";
import { useOnboarding } from "../wallet/useOnboarding";
import { useWallet } from "../wallet/WalletContext";

export function StakePage() {
  const w = useWallet();
  const address = w.active?.address ?? null;
  const protocol = useStakingProtocol();
  const position = useStakePosition(address);
  const ob = useOnboarding();
  const balances = ob.balances;
  const setupDone = stakeSetupDone(ob.steps);
  const p = protocol.data;
  const cooldownSec = p?.cooldownSec ?? null;

  return (
    <>
      <Section
        tone="hero"
        space="md"
        headingAs="h1"
        headerSize="lg"
        eyebrow="Stake"
        title="Stake BKRN"
        lead={
          <>
            Staked <Term id="bkrn">BKRN</Term> is the bond behind the protocol's roles: <Term id="sponsor">sponsors</Term>, Risk Committee members and larger agent operators lock part of their stake
            to show they will play by the rules. Anyone can stake. Stakers have no claim on any book's USDC or fee flow; when a keeper buys BKRN back with half of the{" "}
            <Term id="carry">carry</Term>, the staking contract shares it across all stake, and that can be zero.
          </>
        }
        actions={
          <>
            <a className="btn btn-primary" href="#your-stake">
              Your stake
            </a>
            <a className="btn" href="#where-it-comes-from">
              How it works
            </a>
          </>
        }
      >
        {protocol.noBooks ? (
          <Callout tone="warn" title="Staking figures are not available yet">
            The API lists no books yet, so the staking contract cannot be found. This page fills in as soon as the first book is listed.
          </Callout>
        ) : (
          <StakeOverview data={p} isLoading={protocol.isLoading} error={protocol.error} onRetry={protocol.refetch} noBooks={protocol.noBooks} />
        )}
      </Section>

      <Section id="your-stake" space="sm" className="scroll-mt-20" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" aria-label="Your stake">
        <div className="min-w-0 space-y-6">
          {!setupDone && (
            <SetupChecklist
              title="Get set up to stake"
              description="Staking needs the first three steps: a wallet, the network and a little ETH for gas. Test USDC is only for investing in books."
              whenReady="hide"
              compact
            />
          )}
          {address && (
            <StakePosition
              position={position.data}
              walletBkrn={balances.bkrn}
              totalStaked={p?.totalStaked}
              cooldownSec={cooldownSec}
              isLoading={position.isLoading}
              error={position.error}
              onRetry={() => void position.refetch()}
            />
          )}
          <StakeActions
            // a review is built for one account (balance, allowance): switching accounts starts over
            key={address ?? "none"}
            address={address}
            staking={p?.staking ?? protocol.contracts?.staking ?? null}
            bkrn={p?.bkrn ?? protocol.contracts?.bkrn ?? null}
            position={position.data}
            positionLoading={position.isLoading}
            walletBkrn={address ? balances.bkrn : undefined}
            cooldownSec={cooldownSec}
          />
        </div>
        <StakeAside data={p} />
      </Section>

      <Section
        id="where-it-comes-from"
        tone="muted"
        className="scroll-mt-20"
        eyebrow="Buybacks"
        title="Where stakers' BKRN comes from"
        lead={`Nothing stakers receive comes from book capital. They share BKRN that the protocol buys ${buybackWhere(isTestChain)}, with half of its carry. The other half goes to the backstop pool.`}
      >
        <CarryFlow data={p} />
      </Section>

      <Section id="unstaking" className="scroll-mt-20" eyebrow="Unstaking" title="Getting your BKRN back" lead="Leaving is a two-step exit with a wait in between. Nothing is sent on its own: you start each step.">
        <CooldownTimeline cooldownSec={cooldownSec} />
      </Section>

      <Section id="risks" tone="muted" className="scroll-mt-20" eyebrow="Risks" title="What can go wrong" lead="Staking is simple, but it is not free of risk. Read this before you stake.">
        <StakeRisks />
      </Section>

      <Section id="questions" className="scroll-mt-20" container="prose" eyebrow="Questions" title="Staking questions">
        <StakeFaq cooldownSec={cooldownSec} />
      </Section>
    </>
  );
}
