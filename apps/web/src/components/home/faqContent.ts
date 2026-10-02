// Home FAQ: plain-text answers (checked against docs/ARCHITECTURE.md and the product overview, and by
// the copy rules in test/home.test.ts). The Faq component adds glossary terms and links per item.
import { SPONSOR_SKIN_LINE } from "../../lib/copy";
import type { GlossaryId } from "../../lib/glossary";

export interface FaqItem {
  id: string;
  question: string;
  /** Paragraphs. */
  answer: string[];
  /** Glossary terms shown under the answer. */
  terms?: GlossaryId[];
  /** Internal links shown under the answer. */
  links?: Array<{ to: string; label: string }>;
}

export interface FaqContext {
  /** The build targets a test network (devnet or testnet). */
  testnet: boolean;
  chainName: string;
  chainId: number;
}

export function faqItems(ctx: FaqContext): FaqItem[] {
  return [
    {
      id: "perp",
      question: "What is a perp market?",
      answer: [
        "A perp, short for perpetual future, is a contract that follows an asset's price and never expires. Traders go long or short with margin, and regular funding payments keep its price close to the asset's.",
        "Each Bookrunner book is the house for one perp market. It funds that market's insurance fund and the inventory a market maker quotes with. Anyone can trade the market on its venue.",
      ],
      terms: ["perp", "insuranceFund", "marketMaker"],
    },
    {
      id: "money",
      question: "Where does the money come from?",
      answer: [
        "From the market's fee flow. On Orderly books it is the builder share of taker fees; on the in-house engine it is taker fees, liquidation fees and spread capture.",
        "Each period the waterfall pays expenses first, then the 10% protocol carry, then Senior's hurdle share, then the rest to Junior. Gains or losses on the market-making inventory move NAV at each mark; a gain first restores any Senior shortfall, then goes to Junior.",
        "Fee flow is shown as the observed accrual over each mark period, never as a rate. Past periods say nothing about the next one.",
      ],
      terms: ["feeFlow", "waterfall", "hurdle", "carry"],
    },
    {
      id: "lose",
      question: "What can I lose?",
      answer: [
        "Part or all of what you deposit. Losses hit Junior first, then Senior. If a book's Junior is used up, the backstop may cover Senior's shortfall, but only up to what the pool holds. Senior is last loss, not no loss.",
        "Other risks are real too: bugs in the contracts, a wrong oracle price, and venue custody on Orderly books, where the venue holds margin and runs liquidations.",
      ],
      terms: ["junior", "senior", "backstop"],
    },
    {
      id: "tranches",
      question: "Senior or Junior: what is the difference?",
      answer: [
        "Senior is paid first from fee flow, up to the hurdle share set in the book's charter, and takes losses last. Senior redemptions settle at NAV at the next mark.",
        "Junior receives the rest of the fee flow and the inventory gains, and takes losses first. Junior redemptions settle at the first mark after a notice period.",
        SPONSOR_SKIN_LINE,
      ],
      terms: ["senior", "junior", "redemptionNotice"],
    },
    {
      id: "nav",
      question: "How often is NAV updated?",
      answer: [
        "Once per mark period: hourly on testnet, daily on mainnet. A mark is the book's signed statement of NAV, inventory and P&L, committed on-chain in one transaction per book.",
        "Each mark carries a receipts root, so anyone can check that a quote, fill or hedge belongs to the signed statement. Between marks the app may show a live estimate, clearly labelled; deposits and redemptions always settle at a marked NAV.",
      ],
      terms: ["mark", "nav", "merkleReceipt"],
    },
    {
      id: "deposit",
      question: "How do I deposit?",
      answer: [
        "Live books take deposits during a top-up round that the sponsor opens, with a capacity for each tranche. Your wallet asks you to approve USDC, then to deposit it; nothing moves without your signature.",
        "Deposits wait in escrow until the round ends and cannot be cancelled before it settles. At the first mark after the round end, they are accepted at that mark's share price, up to the capacity. If a round is oversubscribed, every deposit is filled pro-rata and the rest is refunded; if the book retires first, the round is cancelled and every deposit is refunded in full.",
      ],
      terms: ["topUpRound", "sharePrice"],
      links: [{ to: "/invest", label: "Compare the books" }],
    },
    {
      id: "withdraw",
      question: "How do I withdraw?",
      answer: [
        "Request a redemption from the book page or your portfolio. Senior requests settle at NAV at the next mark; Junior requests settle at the first mark after the book's notice period. Then you claim your USDC.",
        "Notice is not a gate: a request is always accepted, and no pause or kill can block it. A claim can only wait for cash to come back from the venue.",
      ],
      terms: ["redemptionNotice", "killSwitch"],
      links: [{ to: "/portfolio", label: "Open your portfolio" }],
    },
    ctx.testnet
      ? {
          id: "testnet",
          question: "What is the testnet?",
          answer: [
            `A practice network where tokens have no value. Bookrunner runs its books on ${ctx.chainName} (chain ${ctx.chainId}) so you can try every step for free.`,
            "Gas ETH comes from the public faucet, and the test USDC has an open mint you can use from your wallet. Test balances never turn into real money, and nothing here is an offer.",
          ],
          terms: ["testnet", "gas", "usdc"],
        }
      : {
          id: "network",
          question: `What is ${ctx.chainName}?`,
          answer: [
            `The network Bookrunner's contracts run on (chain ${ctx.chainId}). Every transaction pays a small gas fee in ETH, and books are funded in USDC on this network.`,
            "Stock Tokens and stock-perp books are not offered to US persons.",
          ],
          terms: ["gas", "usdc", "stockToken"],
        },
    {
      id: "agent",
      question: "Who runs the agent?",
      answer: [
        "An agent operator runs the bookrunner agent software, and the sponsor registers its keys on the book's mandate. Above the entry inventory tier, the operator locks a BKRN bond sized to the inventory it runs.",
        "The keys can only take the actions the mandate allows. Hedges and inventory moves are checked on-chain by the mandate contract; quoting on the venue is watched by the risk service, which cancels quotes and revokes keys on a breach.",
      ],
      terms: ["bookrunnerAgent", "mandate", "hedgeBand"],
      links: [{ to: "/agents", label: "See the agents" }],
    },
    {
      id: "bkrn",
      question: "What is BKRN?",
      answer: [
        "Bookrunner's token, with a fixed supply of 1 billion and no minting after launch. Staked BKRN is the bond that sponsors, committee members and larger agent operators post, and a bond can be slashed for misconduct.",
        "Half of the protocol carry buys BKRN, which the staking contract distributes to stakers; the other half funds the USDC backstop. BKRN is for access and bonding, never a revenue claim.",
      ],
      terms: ["bkrn", "staking", "backstop"],
      links: [{ to: "/stake", label: "Stake BKRN" }],
    },
  ];
}
