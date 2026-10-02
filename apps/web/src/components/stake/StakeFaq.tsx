// Common questions about staking, answered from contracts/src/BkrnStaking.sol, BkrnFeeRouter.sol and
// Backstop.sol. The cooldown length is the live value.
import { Link } from "react-router";
import { config } from "../../lib/config";
import { fmtDuration } from "../../lib/format";
import { termAnchor } from "../../lib/glossary";
import { isTestChain } from "../../wallet/network";
import { CarryPct } from "../ProtocolTerms";
import { Accordion, type AccordionItem, Term } from "../ui";

export function StakeFaq({ cooldownSec }: { cooldownSec: number | null }) {
  const wait = cooldownSec === null ? "the cooldown (7 days by default)" : fmtDuration(cooldownSec);
  const items: AccordionItem[] = [
    {
      id: "why",
      title: "Why would I stake BKRN?",
      content: (
        <>
          <p>
            Staked BKRN is how Bookrunner asks people with power over a book to put something on the line. A <Term id="sponsor">sponsor</Term> needs a bond to file a charter, each{" "}
            <Term id="riskCommittee">Risk Committee</Term> member needs one to vote, and an agent operator needs one to run a book above the entry inventory tier. Those bonds are locked from staked
            BKRN.
          </p>
          <p className="mt-2">
            Anyone can also stake without a role. Every staker shares the BKRN bought back with half of the protocol carry. It is access and bonding, never a revenue claim.
          </p>
        </>
      ),
    },
    {
      id: "source",
      title: "Where does the BKRN I can claim come from?",
      content: (
        <p>
          Each book pays <CarryPct /> of its fee flow, after expenses, as <Term id="carry">protocol carry</Term>. The fee router sends half to the USDC backstop pool. A keeper swaps the other half for BKRN on
          the market and hands it to the staking contract, which shares it across all staked BKRN at that moment, in proportion to each stake. Your part waits in the contract until you claim it.
        </p>
      ),
    },
    {
      id: "rate",
      title: "How much will I receive?",
      content: (
        <p>
          No one can say in advance. It depends on how much fee flow the books collect, the price of BKRN at each buyback, how often a keeper runs one, and how much BKRN is staked in total. It can be
          zero, and Bookrunner never quotes it as a rate.
        </p>
      ),
    },
    {
      id: "slash",
      title: "Can I lose staked BKRN?",
      content: (
        <p>
          Book losses never use staked BKRN: they fall on Junior, then Senior, then the USDC <Term id="backstop">backstop</Term> pool. Only stake locked as a bond can be slashed, and only by the
          contract that locked it. Plain stake cannot be slashed. The market price of BKRN can still fall, which is a separate risk.
        </p>
      ),
    },
    {
      id: "cooldown",
      title: "How long does unstaking take?",
      content: (
        <p>
          You request an amount, wait {wait}, then withdraw it with a second transaction. During the wait the BKRN still counts as staked, so it keeps its share of any buyback. A new request adds to
          the one already waiting and restarts the clock for the whole amount. You can cancel a request at any time before you withdraw.
        </p>
      ),
    },
    {
      id: "locked",
      title: "Why is part of my stake locked?",
      content: (
        <p>
          Your wallet holds a protocol role, and the bond for it is locked from your stake. The charter contract releases a sponsor bond when the book is retired or the charter is refunded, a former
          committee member can release their bond after leaving the seat, and a book's mandate releases an agent bond when that agent key is revoked. Until then the locked part cannot be unstaked.
        </p>
      ),
    },
    {
      id: "approve",
      title: "Why does my wallet ask for two confirmations?",
      content: (
        <p>
          A token contract only lets another contract move your tokens after you allow it. The first confirmation allows the staking contract to take exactly the amount you typed, and nothing more.
          The second one stakes it. If an earlier approval already covers the amount, the first step is skipped.
        </p>
      ),
    },
    {
      id: "testnet",
      title: isTestChain ? "How do I get BKRN on testnet?" : "Where do I get BKRN?",
      content: isTestChain ? (
        <p>
          You cannot mint it here. BKRN has a fixed supply of 1 billion and no mint function, unlike the test USDC. On this testnet it was sent at launch to the protocol's test accounts (sponsor,
          committee and agent operator). A new wallet usually holds none, but every figure on this page is live, and you can still follow how staking works. Test USDC for books is free:{" "}
          <Link className="link" to="/invest">
            invest in a book
          </Link>
          .
        </p>
      ) : (
        <p>BKRN is a regular token on {config.chain.name}. Bookrunner does not sell it.</p>
      ),
    },
    {
      id: "glossary",
      title: "Where can I read more?",
      content: (
        <p>
          The{" "}
          <Link className="link" to={`/learn#${termAnchor("staking")}`}>
            glossary entry on staking
          </Link>{" "}
          and the{" "}
          <Link className="link" to="/learn">
            How it works
          </Link>{" "}
          page explain books, tranches, carry and the backstop step by step.
        </p>
      ),
    },
  ];
  return <Accordion items={items} defaultOpen={["why"]} headingLevel={3} />;
}
