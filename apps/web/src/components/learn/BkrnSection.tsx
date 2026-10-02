// 8. BKRN: where the protocol carry goes (half buys BKRN for stakers, half funds the backstop), what
// staked BKRN is used for (bonds), and live figures from the staking contract and the backstop pool.
import { Link } from "react-router";
import { BKRN_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import { fmtDuration, fmtUsd } from "../../lib/format";
import { useBackstopBalance } from "../../wallet/backstop";
import { IconArrowRight } from "../icons";
import { Term } from "../Term";
import { Card, Stat, StatGrid } from "../ui";
import { Figure, FlowArrow, FlowNode, LearnSection, Prose } from "./parts";
import { useStakingStats } from "./useLearnData";

/** 18dp BKRN as whole tokens, compact ("2.2M", "1B"); the exact amount goes in the tooltip. */
const compactBkrn = (raw: bigint) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(raw / 10n ** BigInt(BKRN_DECIMALS)));

const BONDS = [
  { title: "Sponsor bond", body: "Locked when a sponsor files a charter. It can be slashed if the sponsor abandons a live book.", term: "sponsor" as const },
  { title: "Committee seat", body: "Each Risk Committee member stakes a bond to sit and vote. Misconduct can be slashed.", term: "riskCommittee" as const },
  { title: "Agent operator bond", body: "Operators running an agent above the entry inventory tier lock a bond sized to that tier.", term: "bookrunnerAgent" as const },
];

export function BkrnSection(props: { index: number }) {
  const pool = useBackstopBalance();
  const staking = useStakingStats();
  const poolText = pool.data !== undefined ? fmtUsd(pool.data, { compact: true }) : pool.error ? "Unavailable" : "Loading";
  const stakingValue = <T,>(v: T | null | undefined, fmt: (x: T) => string) => (v != null ? fmt(v) : staking.error || staking.data ? "Unavailable" : "Loading");
  const stakedText = stakingValue(staking.data?.totalStaked, compactBkrn);
  const cooldownText = stakingValue(staking.data?.cooldownSeconds, (v) => fmtDuration(v));
  const supplyText = stakingValue(staking.data?.totalSupply, compactBkrn);
  const exact = (v: bigint | null | undefined) => (v != null ? `${formatAmountDisplay(v, BKRN_DECIMALS, 0)} BKRN` : undefined);
  return (
    <LearnSection
      id="bkrn"
      index={props.index}
      eyebrow="BKRN"
      title="BKRN: access and bonding"
      lead={
        <>
          <Term id="bkrn">BKRN</Term> is Bookrunner's token, with a fixed supply of 1 billion and no minting after launch. It is used for access and bonding, never as
          a claim on revenue.
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Figure label="Where the protocol carry goes" caption="The carry is the protocol's only cut: there is no management fee on capital.">
          <div className="flex flex-col items-stretch">
            <FlowNode series="fee" title="Fee flow of every book">
              After expenses, the protocol takes its carry before Senior.
            </FlowNode>
            <FlowArrow vertical label="10%" />
            <FlowNode series="bkrn" title={<Term id="carry">Protocol carry</Term>}>
              Split in half by the fee router.
            </FlowNode>
            <div className="mt-1 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col items-stretch">
                <FlowArrow vertical label="50%" series="bkrn" />
                <FlowNode series="bkrn" title="Buys BKRN on the market">
                  The bought BKRN goes to the <Term id="staking">staking</Term> contract, which distributes it to stakers.
                </FlowNode>
              </div>
              <div className="flex flex-col items-stretch">
                <FlowArrow vertical label="50%" series="backstop" />
                <FlowNode series="backstop" title={<Term id="backstop">Backstop pool</Term>} className="border-dashed">
                  Stays in USDC. Covers a Senior shortfall once a book's Junior is used up, up to what the pool holds.
                </FlowNode>
              </div>
            </div>
          </div>
        </Figure>
        <div className="space-y-4">
          <StatGrid cols={2}>
            <Stat label="Backstop pool" value={poolText} sub="USDC, shared by every book" series="backstop" title={pool.data !== undefined ? `${fmtUsd(pool.data)} USDC` : undefined} />
            <Stat label="BKRN staked" value={stakedText} sub="BKRN in the staking contract" series="bkrn" title={exact(staking.data?.totalStaked)} />
            <Stat label="Unstake cooldown" value={cooldownText} sub="before staked BKRN can leave" />
            <Stat label="Total supply" value={supplyText} sub="BKRN, fixed at launch" title={exact(staking.data?.totalSupply)} />
          </StatGrid>
          <p className="text-[12px] text-muted">Read live from the contracts on this network.</p>
        </div>
      </div>

      <Prose className="mt-8">
        <p>
          Staking BKRN is how people get a seat at the table. The three roles with power over a book must lock staked BKRN as a bond first, and that bond can be
          slashed for misconduct.
        </p>
      </Prose>
      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {BONDS.map((b) => (
          <Card as="li" key={b.title} padding="md">
            <h3 className="text-[14.5px] font-semibold text-ink">{b.title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{b.body}</p>
            <p className="mt-2 text-[12px] text-muted">
              Term: <Term id={b.term} />
            </p>
          </Card>
        ))}
      </ul>
      <div className="mt-5">
        <Link to="/stake" className="btn btn-secondary">
          Go to staking <IconArrowRight size={14} />
        </Link>
      </div>
    </LearnSection>
  );
}
