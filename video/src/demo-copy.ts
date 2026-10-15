// Captions for the screen-recorded product demos (video/demo/scenarios/*.mjs). One entry per clip: a title card,
// a subtitle and one caption per step key the scenario logs (the recorder's reserved keys `__sync` / `loaded` have
// none). Each caption is one idea, at most 90 characters, facts only (README.md, docs/ARCHITECTURE.md), and passes
// the repo copy rules (packages/shared/src/copy.ts via scripts/check-copy.ts).
export const DEMO_IDS = ["site", "allocator", "sponsor", "risk"] as const;
export type DemoId = (typeof DEMO_IDS)[number];

export interface DemoClipCopy {
  title: string;
  subtitle: string;
  steps: Record<string, string>;
}

export const DEMO_COPY: Record<DemoId, DemoClipCopy> = {
  site: {
    title: "Bookrunner in two minutes",
    subtitle: "The public site, the live desk and the rulebook · Robinhood Chain testnet",
    steps: {
      hero: "Bookrunner: the underwriting syndicate for on-chain perp markets.",
      ecosystem: "One book per market: allocators pick the book, then Senior or Junior.",
      "fee-flow": "The book backs the market's insurance fund and market-making inventory.",
      dashboard: "The live desk: three books on Robinhood Chain testnet.",
      books: "Each book shows its marked NAV, split into Senior and Junior.",
      "desk-activity": "Desk activity: marks committed and fee flow distributed, each with its tx.",
      status: "The status page checks every book's latest mark and risk state.",
      rulebook: "The rulebook: the protocol's rules, in full.",
      tranches: "Senior: first claim on fee flow up to its share, last loss. Junior: residual, first loss.",
      waterfall: "Fee flow pays expenses, then 10% protocol carry, then Senior, then Junior.",
      "loss-order": "Losses run the other way: Junior first, then Senior, then the backstop up to the pool.",
      mandate: "Agents quote and hedge; the mandate sets inventory, skew, leverage and off-hours limits.",
      marks: "Every mark is signed; hourly receipt roots cover quotes, fills, hedges and decisions.",
    },
  },
  allocator: {
    title: "Deposit into a book",
    subtitle: "An allocator funds the NVDA book's Junior tranche · test USDC on Robinhood Chain testnet",
    steps: {
      home: "The Bookrunner app, connected to Robinhood Chain testnet.",
      connect: "Connect a wallet: this only shares its address.",
      balances: "The wallet holds test ETH for gas; test tokens have no value.",
      mint: "Mint 10,000 test USDC: a real testnet transaction, signed by the wallet.",
      minted: "Minted: the test USDC is in the wallet.",
      books: "Books: one per perp market, each marked on-chain every period.",
      book: "The NVDA book: state, venue, agent status and the next mark.",
      nav: "NAV history from signed marks, split into Senior and Junior.",
      waterfall: "The last distribution: expenses, carry, Senior share, Junior residual.",
      fills: "Fills and hedges by the book's agent, each with a receipt to verify.",
      marks: "Every mark is signed (EIP-712) and committed on-chain.",
      tranche: "Choose a tranche: Junior takes the residual fee flow and the first loss.",
      amount: "Deposit 1,000 test USDC, within the round's room and the wallet cap.",
      review: "Review: the app prepares two transactions, an approve and the deposit.",
      sign: "Sign and send: the wallet signs both transactions on testnet.",
      confirmed: "Both receipts confirmed: the deposit waits in escrow for its mark.",
      portfolio: "Portfolio: the deposit is pending, in escrow until a mark accepts it.",
      pending: "Shares are issued at the first mark after the round ends.",
      withdraw: "Withdraw: once shares are held, request a withdrawal at any time.",
    },
  },
  sponsor: {
    title: "File a market charter",
    subtitle: "A sponsor proposes a new perp market · Robinhood Chain testnet, nothing signed",
    steps: {
      charters: "Charters: every market starts as a filed charter.",
      connect: "The sponsor connects a wallet.",
      form: "File a charter: five steps, from the market to the review.",
      market: "Market: an AAPL Stock Token perp, Orderly-listed, with an attested oracle.",
      capital: "Capital: the insurance fund and the market-making inventory to raise.",
      mandate: "Mandate: inventory, skew, width, hedge band and drawdown kill for the agents.",
      tranches: "Tranche terms: Senior cap, Senior share, window and Junior notice.",
      review: "Review: every term on one page before filing.",
      prepared: "Validated; the filing transactions are prepared. This demo stops before signing.",
      charter: "An approved charter: NVDA, now book #1.",
      jury: "The model-jury verdict, content-addressed, its digest posted on-chain.",
      votes: "The Risk Committee: two of three bonded members approved.",
      committee: "Committee: recent decisions on every filed charter.",
      book: "The approved charter became a live book.",
    },
  },
  risk: {
    title: "Limits, marks and proofs",
    subtitle: "How a book's risk is checked and its marks verified · Robinhood Chain testnet",
    steps: {
      risk: "Risk: every book's limit state, refreshed every few seconds.",
      "kill-log": "A breach cancels quotes, flattens within the mandate and revokes keys.",
      agents: "Agents: desk session keys, their bonded tier and the agent heartbeat.",
      "agent-books": "Each book has its own desk keys, each bonded for its inventory tier.",
      book: "The NVDA book.",
      limits: "Live limits: inventory, hedge ratio, skew and drawdown against the kill level.",
      marks: "Marks: signed EIP-712, one on-chain transaction per book per period.",
      "verify-mark": "Verify: the receipts root is rebuilt in the browser and matches the mark.",
      "verify-receipt": "Any receipt can be checked locally against its hourly Merkle root.",
      waterfall: "Fee-flow waterfall: every unit of the last distribution is accounted for.",
      "loss-junior": "Losses run the other way: at a mark, Junior absorbs a loss first.",
      "loss-senior": "Past Junior, Senior absorbs next; the backstop covers Senior up to the pool.",
    },
  },
};

/** Shared by every clip: the title card's network label and the end card (site, X handle, disclaimer). */
export const DEMO_CARDS = {
  network: "Robinhood Chain testnet",
  url: "bookrunner.tech",
  x: "@TryBookRunner",
  disclaimer: "Testnet software. Not an offer.",
} as const;
