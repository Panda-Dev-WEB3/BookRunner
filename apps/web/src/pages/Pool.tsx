// Insurance Pool (/pool): the protocol-wide pool whose depositors fund the insurance fund of every pool-funded
// book and receive a premium from its gross fee flow. Pool figures, the wallet's shares and requests with the
// deposit / withdraw / cancel / collect flows (prepared by the API, verified against the chain's pool address and
// sent through TxRunner), the epoch queue, observed share price and premium history, exposure per market, the
// first-loss slice and the risks. Facts follow InsurancePool.sol (docs/ARCHITECTURE.md §2.10).
import { useState } from "react";
import { FirstLossExplainer, PoolRisks } from "../components/pool/PoolRisks";
import { PoolActions } from "../components/pool/PoolActions";
import { PoolExposure } from "../components/pool/PoolExposure";
import { type HistoryWindow, PoolHistory } from "../components/pool/PoolHistory";
import { PoolOverview } from "../components/pool/PoolOverview";
import { PoolPosition } from "../components/pool/PoolPosition";
import { EpochHistory, EpochStatus } from "../components/pool/PoolQueue";
import { DEFAULT_PREMIUM_FLOOR_BPS } from "../components/pool/poolLogic";
import { usePoolEpochs, usePoolExposure, usePoolHistory, usePoolOverview, usePoolPosition } from "../components/pool/usePool";
import { SetupChecklist } from "../components/SetupChecklist";
import { Callout, Card, EmptyState, Hash, Section, Term } from "../components/ui";
import { useQueryError } from "../api/hooks";
import { bpsPct } from "../lib/format";
import { useInsurancePoolAddress } from "../wallet/contracts";
import { useOnboarding } from "../wallet/useOnboarding";
import { sameAddress, useWallet } from "../wallet/WalletContext";

function PoolInShort({ floorBps }: { floorBps: number }) {
  const points = [
    { title: "What you fund", body: "The insurance fund of every pool-funded book. Sponsors then raise only the market-making inventory." },
    { title: "What the pool receives", body: `A premium on each such book's gross fee flow: the charter's rate, at least ${bpsPct(floorBps)}. Paid before expenses and carry.` },
    { title: "What it is not", body: "Not a tranche of any book, and not the backstop pool: the backstop never pays a book's debt to the insurance pool." },
  ];
  return (
    <Card title="The pool in short" padding="md">
      <ul className="space-y-3">
        {points.map((p) => (
          <li key={p.title}>
            <div className="text-[13.5px] font-semibold text-ink">{p.title}</div>
            <div className="text-[12.5px] text-ink-2">{p.body}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PoolContract({ apiAddress }: { apiAddress: string | null }) {
  const chain = useInsurancePoolAddress();
  if (chain.data === undefined) return null;
  const mismatch = !!chain.data && !!apiAddress && !sameAddress(chain.data, apiAddress);
  return (
    <Card title="Contract" description="Every transaction on this page is checked against the pool address read from the chain's protocol registry before your wallet opens." padding="md">
      <div className="flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-ink-2">Insurance pool</span>
        {chain.data ? <Hash value={chain.data} kind="address" /> : <span className="text-muted">none on this deployment</span>}
      </div>
      {mismatch && <p className="mt-2 text-[12px] text-critical-ink">The API reports a different pool address. Nothing it prepares for another address can be sent from this page.</p>}
    </Card>
  );
}

export function PoolPage() {
  const w = useWallet();
  const address = w.active?.address ?? null;
  const ob = useOnboarding();
  const overview = usePoolOverview();
  const supported = overview.supported === true;
  const available = supported && overview.data?.available === true;
  const position = usePoolPosition(address, available);
  const positionError = useQueryError(position);
  const epochs = usePoolEpochs(available);
  const epochsError = useQueryError(epochs);
  const [win, setWin] = useState<HistoryWindow>("90");
  const history = usePoolHistory(available, Number(win));
  const historyError = useQueryError(history);
  const exposure = usePoolExposure(available);
  const exposureError = useQueryError(exposure);
  const overviewError = useQueryError(overview.q);
  const o = overview.data;
  const floor = o?.params?.premiumFloorBps ?? DEFAULT_PREMIUM_FLOOR_BPS;
  const setupDone = ["connect", "network", "gas"].every((id) => ob.steps.find((s) => s.id === id)?.status === "done");

  const unavailable =
    overview.supported === false ? (
      <EmptyState title="This API does not serve the insurance pool yet" body="The pool's figures and flows appear here once the API is updated." />
    ) : supported && o && !o.available ? (
      <EmptyState title="No insurance pool on this deployment" body="Books on this network fund their insurance fund from their own tranches." />
    ) : null;

  return (
    <>
      <Section
        tone="hero"
        space="md"
        headingAs="h1"
        headerSize="lg"
        eyebrow="Insurance pool"
        title="The insurance pool"
        lead={
          <>
            Depositors fund the <Term id="insuranceFund">insurance fund</Term> of every pool-funded book and receive a premium from its gross <Term id="feeFlow">fee flow</Term>. Each book owes that
            insurance fund to the pool as a senior debt: its Junior and Senior take losses first. Entry and exit are queued to weekly <Term id="poolEpoch">epochs</Term>.
          </>
        }
        actions={
          available ? (
            <>
              <a className="btn btn-primary" href="#your-pool">
                Deposit or withdraw
              </a>
              <a className="btn" href="#risks">
                Risks
              </a>
            </>
          ) : undefined
        }
      >
        {unavailable ?? <PoolOverview data={o} error={overviewError} onRetry={() => void overview.q.refetch()} />}
      </Section>

      {available && (
        <>
          <Section id="your-pool" space="sm" className="scroll-mt-20" bodyClassName="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" aria-label="Your pool position">
            <div className="min-w-0 space-y-6">
              {!setupDone && (
                <SetupChecklist
                  title="Get set up for the pool"
                  description="Depositing needs a wallet on this network, a little ETH for gas and the settlement token."
                  steps={["connect", "network", "gas", "usdc"]}
                  whenReady="hide"
                  compact
                />
              )}
              {address && <PoolPosition position={position.data} isLoading={position.isLoading} error={positionError} onRetry={() => void position.refetch()} />}
              <PoolActions
                key={address ?? "none"}
                address={address}
                overview={o}
                position={position.data}
                positionLoading={position.isLoading}
                positionError={positionError}
                onRetry={() => void position.refetch()}
                walletUsdc={ob.balances.usdc}
              />
            </div>
            <div className="space-y-6">
              <EpochStatus overview={o} />
              <PoolInShort floorBps={floor} />
              <PoolContract apiAddress={o?.address ?? null} />
            </div>
          </Section>

          <Section
            id="queue"
            tone="muted"
            className="scroll-mt-20"
            eyebrow="Queue"
            title="Epochs"
            lead="Every deposit and withdrawal joins a weekly epoch and is priced when that epoch is processed: after every pool-funded book has marked past the epoch end, or after the grace period at most, so exits are never blocked. A stale epoch was processed after the grace with some books not yet marked."
          >
            <EpochHistory data={epochs.data} error={epochsError} onRetry={() => void epochs.refetch()} />
          </Section>

          <Section id="history" className="scroll-mt-20" eyebrow="History" title="Share price and premium history (observed)" lead="What happened, never a forecast: the share price at each snapshot and the premiums and losses per day.">
            <PoolHistory data={history.data} error={historyError} onRetry={() => void history.refetch()} window={win} onWindow={setWin} />
          </Section>

          <Section
            id="exposure"
            tone="muted"
            className="scroll-mt-20"
            eyebrow="Exposure"
            title="Exposure per market"
            lead="The books on one underlying share a cap on what they can draw from the pool. Repayable is what each book could pay back at its last mark."
          >
            <PoolExposure data={exposure.data} error={exposureError} onRetry={() => void exposure.refetch()} />
          </Section>

          <Section id="risks" className="scroll-mt-20" eyebrow="Risks" title="Who takes a loss first" lead="Read this before you deposit.">
            <div className="space-y-6">
              <PoolRisks overview={o} />
              <FirstLossExplainer overview={o} />
              {o?.paused?.allocations && (
                <Callout tone="neutral" compact title="New allocations are paused">
                  The guardian paused lending to new books. Books already funded are unaffected, and exits keep working.
                </Callout>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
