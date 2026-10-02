// Side column of the Stake page: a short "what staking is and is not", the testnet BKRN note, and
// the contracts every figure is read from.
import { config } from "../../lib/config";
import { isTestChain } from "../../wallet/network";
import { cx } from "../cx";
import { IconCheck, IconClose } from "../icons";
import { Callout, Card, Hash, Term } from "../ui";
import type { StakingProtocol } from "./useStaking";

const POINTS: Array<{ yes: boolean; title: string; body: string }> = [
  { yes: true, title: "Access and bonding", body: "Sponsors, committee members and larger agent operators lock staked BKRN as a bond for their role." },
  { yes: true, title: "A share of buybacks", body: "Half of the protocol carry buys BKRN, shared across all stake in proportion." },
  { yes: false, title: "Not a revenue claim", body: "There is no fixed rate. What stakers receive can be zero." },
  { yes: false, title: "Not the backstop", body: "Book losses use the USDC backstop pool, never staked BKRN." },
];

function InShort() {
  return (
    <Card title="Staking in short" padding="md">
      <ul className="space-y-3">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-2.5">
            <span
              className={cx("mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full", p.yes ? "bg-good/12 text-good-ink" : "bg-surface-3 text-ink-2")}
              aria-hidden
            >
              {p.yes ? <IconCheck size={12} strokeWidth={2.4} /> : <IconClose size={12} strokeWidth={2.4} />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-ink">
                <span className="sr-only">{p.yes ? "Is: " : "Is not: "}</span>
                {p.title}
              </span>
              <span className="block text-[12.5px] text-ink-2">{p.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function StakeContracts({ data }: { data: StakingProtocol | undefined }) {
  if (!data) return null;
  const rows: Array<[string, string]> = [
    ["Staking", data.staking],
    ["BKRN token", data.bkrn],
    ["Fee router", data.feeRouter],
    ["Backstop pool", data.backstop],
  ];
  return (
    <Card title="Contracts" description="Every figure on this page is read from these addresses. Open them in the explorer to check." padding="md">
      <dl className="divide-y divide-line text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 py-2">
            <dt className="text-ink-2">{k}</dt>
            <dd>
              <Hash value={v} kind="address" />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function StakeAside({ data }: { data: StakingProtocol | undefined }) {
  return (
    <div className="space-y-6">
      <InShort />
      {isTestChain && (
        <Callout tone="neutral" title={config.chain.kind === "devnet" ? "Devnet BKRN" : "Testnet BKRN"}>
          BKRN cannot be minted from this app: its supply is fixed at 1 billion, with no mint even on this <Term id="testnet">test network</Term>. At launch it was sent to the protocol's test
          accounts, so a new wallet usually holds none. The live figures still show how staking works.
        </Callout>
      )}
      <StakeContracts data={data} />
    </div>
  );
}
