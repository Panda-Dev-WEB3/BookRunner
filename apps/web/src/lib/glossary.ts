// Plain-language glossary for the investor pages (Term tooltips, the Learn page). Every definition is
// checked against docs/ARCHITECTURE.md and the product overview, and passes the copy rules (tests:
// test/glossary.test.ts). `short` fits a tooltip (one or two sentences); `long` adds the detail.

export type GlossaryId =
  | "book"
  | "charter"
  | "sponsor"
  | "riskCommittee"
  | "allocator"
  | "tranche"
  | "senior"
  | "junior"
  | "hurdle"
  | "carry"
  | "waterfall"
  | "feeFlow"
  | "nav"
  | "sharePrice"
  | "mark"
  | "merkleReceipt"
  | "mandate"
  | "hedgeBand"
  | "killSwitch"
  | "drawdown"
  | "backstop"
  | "bkrn"
  | "staking"
  | "subscriptionWindow"
  | "topUpRound"
  | "redemptionNotice"
  | "stockToken"
  | "perp"
  | "marketMaker"
  | "bookrunnerAgent"
  | "insuranceFund"
  | "pullOracle"
  | "usdc"
  | "gas"
  | "testnet"
  | "wallet";

export interface GlossaryEntry {
  id: GlossaryId;
  /** Display name, as it should read in a sentence or heading. */
  term: string;
  /** One or two sentences: the tooltip text. */
  short: string;
  /** Optional extra detail for the Learn page. */
  long?: string;
  /** Related terms (for "see also" links). */
  related?: GlossaryId[];
}

const entries: GlossaryEntry[] = [
  {
    id: "book",
    term: "Book",
    short: "One perp market's underwriting pool. Allocators fund it in two tranches; it pays for that market's insurance fund and market-making inventory and earns the market's fee flow.",
    long: "Each book has its own NAV, mandate, marks and contracts. Bookrunner launched with three books on testnet: NVDA and TSLA (listed on Orderly's public contracts) and RHX5, a five-stock index on the in-house engine.",
    related: ["charter", "tranche", "mandate"],
  },
  {
    id: "charter",
    term: "Charter",
    short: "The application that creates a book. A sponsor files the market's terms on-chain: underlying, venue, oracle plan, trading sessions, insurance-fund size, the agent's mandate and the tranche terms.",
    long: "Filing pays a flat USDC fee (refunded if the charter is rejected) and locks the sponsor's BKRN bond. The Risk Committee then approves or rejects it; an approved charter becomes a book with the same id.",
    related: ["sponsor", "riskCommittee", "book"],
  },
  {
    id: "sponsor",
    term: "Sponsor",
    short: "Whoever charters a book: a treasury, a fund or an agent fleet. The sponsor posts a BKRN bond and must hold at least 10% of the book's Junior tranche.",
    long: "Holding Junior is the sponsor's skin in the book: they take the first losses alongside other Junior holders. If a sponsor abandons a live book, the committee may slash the bond.",
    related: ["charter", "junior", "bkrn"],
  },
  {
    id: "riskCommittee",
    term: "Risk Committee",
    short: "Reviews every charter: a model-jury verdict plus three bonded members. Two of the three must approve (three if the jury advised against).",
    long: "Members stake BKRN to sit on the committee. For live books the committee can also re-mandate, retire a book, revoke an agent key or slash a sponsor, each with 2-of-3 approval.",
    related: ["charter", "staking"],
  },
  {
    id: "allocator",
    term: "Allocator",
    short: "Anyone who funds a book by depositing USDC into its Senior or Junior tranche. Allocators receive tranche shares valued at NAV.",
    related: ["tranche", "nav"],
  },
  {
    id: "tranche",
    term: "Tranche",
    short: "A slice of a book with its own place in the payment and loss order. Every book has two: Senior and Junior.",
    long: "Each tranche is a token vault (ERC-4626 shares, 6 decimals). One share is worth 1 USDC when the subscription window closes; after that it moves with the marked NAV.",
    related: ["senior", "junior", "waterfall"],
  },
  {
    id: "senior",
    term: "Senior tranche",
    short: "Paid first from fee flow, up to its hurdle share, and last in line for losses. Junior absorbs losses first; Senior is last loss, not no loss.",
    long: "If losses use up all of a book's Junior, the backstop may cover Senior's shortfall, up to what the pool holds. Senior redemptions settle at NAV at every mark, with no notice period.",
    related: ["junior", "hurdle", "backstop"],
  },
  {
    id: "junior",
    term: "Junior tranche",
    short: "The first-loss tranche. It receives the residual fee flow after Senior's share, so it carries both the upside and the first losses.",
    long: "Junior redemptions settle at NAV at the first mark after the notice period. The sponsor holds at least 10% of Junior.",
    related: ["senior", "redemptionNotice", "sponsor"],
  },
  {
    id: "hurdle",
    term: "Hurdle share",
    short: "Senior's share of each distribution, set in the charter (for example 60%). After expenses and carry, this share of the fee flow goes to Senior first; Junior receives the rest.",
    related: ["senior", "waterfall", "carry"],
  },
  {
    id: "carry",
    term: "Protocol carry",
    short: "The protocol's cut: 10% of each book's fee flow after expenses, taken before Senior. Half buys BKRN for stakers, half goes to the backstop pool.",
    long: "There is no management fee on capital. Expenses (oracle and keeper gas) are capped on-chain before carry is taken.",
    related: ["waterfall", "backstop", "staking"],
  },
  {
    id: "waterfall",
    term: "Waterfall",
    short: "The order money moves in. Fee flow runs down: expenses, then the 10% carry, then Senior's hurdle share, then the Junior residual. Losses run up: Junior first, then Senior, then the backstop up to the pool.",
    related: ["carry", "hurdle", "backstop"],
  },
  {
    id: "feeFlow",
    term: "Fee flow",
    short: "What a book earns from its market: the builder share of taker fees on Orderly books, or taker fees, liquidation fees and spread capture on the in-house engine.",
    long: "Bookrunner shows fee flow as the observed accrual over each mark period. It is never quoted as a rate, and past fee flow says nothing about the next period.",
    related: ["waterfall", "mark"],
  },
  {
    id: "nav",
    term: "NAV",
    short: "Net asset value: what a book, or one tranche share, is worth at the last mark. Deposits and redemptions settle at marked NAV, never at a live estimate.",
    related: ["mark", "sharePrice"],
  },
  {
    id: "sharePrice",
    term: "Share price",
    short: "The value of one tranche share at the last mark, in USDC. It starts at 1.0 when the subscription window closes.",
    related: ["nav", "tranche"],
  },
  {
    id: "mark",
    term: "Mark",
    short: "The book's signed statement for one period: NAV, inventory and P&L, committed on-chain with a receipts root. Applying a mark updates share prices and settles queued redemptions.",
    long: "One mark transaction per book per period: hourly on testnet, daily on mainnet. Between marks the app may show a live estimate, clearly labelled, which is never used for deposits or redemptions.",
    related: ["nav", "merkleReceipt"],
  },
  {
    id: "merkleReceipt",
    term: "Merkle receipt",
    short: "A record of one agent action: a quote, fill, hedge or risk decision. Receipts are hashed into a tree whose root is committed with each mark, so anyone can check a receipt belongs to the signed statement.",
    related: ["mark"],
  },
  {
    id: "mandate",
    term: "Mandate",
    short: "The rule book the agent trades under, set in the charter: minimum quote width, maximum skew and inventory, a hedge band, reduce-only off-hours and a drawdown kill.",
    long: "On-chain actions (hedges, inventory moves) are checked in code by the mandate contract. Quoting on the venue is monitored by the risk service, which cancels quotes and revokes keys on a breach.",
    related: ["hedgeBand", "killSwitch", "bookrunnerAgent"],
  },
  {
    id: "hedgeBand",
    term: "Hedge band",
    short: "The allowed range for the hedge ratio: how much of the book's net exposure is offset by hedges (for example 50% to 120%). Hedge trades must stay in the band or move closer to it.",
    related: ["mandate", "stockToken"],
  },
  {
    id: "killSwitch",
    term: "Kill switch",
    short: "If the drawdown reaches the mandate's kill level, or a limit is breached, the mandate is killed: quoting stops, agent keys are revoked and positions are flattened. A kill never blocks redemptions.",
    long: "The Risk Committee can re-mandate a killed book with new terms; agent keys then have to be registered again.",
    related: ["mandate", "drawdown"],
  },
  {
    id: "drawdown",
    term: "Drawdown",
    short: "How far a book's performance index sits below its high-water mark, in basis points (100 bps = 1%).",
    related: ["killSwitch"],
  },
  {
    id: "backstop",
    term: "Backstop",
    short: "A shared USDC pool funded by half of the protocol carry. It covers a Senior shortfall only once that book's Junior is exhausted, and only up to what the pool holds.",
    related: ["carry", "senior", "waterfall"],
  },
  {
    id: "bkrn",
    term: "BKRN",
    short: "Bookrunner's token, with a fixed supply of 1 billion and no minting after launch. Sponsors, committee members and larger agent operators stake it as a bond.",
    long: "Access and bonding, never a revenue claim. Half of the protocol carry buys BKRN on the market, which is then distributed through the staking contract.",
    related: ["staking", "carry"],
  },
  {
    id: "staking",
    term: "Staking",
    short: "Locking BKRN in the staking contract. Bonds for sponsors, committee seats and agent operators are drawn from staked BKRN.",
    long: "Unstaking starts a cooldown (7 days by default) before the BKRN can be withdrawn. Locked bond amounts cannot be unstaked and may be slashed for misconduct. Bought-back BKRN is distributed to stakers by the staking contract.",
    related: ["bkrn", "sponsor", "riskCommittee"],
  },
  {
    id: "subscriptionWindow",
    term: "Subscription window",
    short: "A new book's first deposit period. When it closes, commitments are allocated pro-rata (the sponsor first in Junior), any excess is refunded and the book goes live.",
    long: "If the window fails its checks (for example not enough Junior), the book is cancelled and every commitment is refundable 1:1.",
    related: ["topUpRound", "allocator"],
  },
  {
    id: "topUpRound",
    term: "Top-up round",
    short: "A deposit window the sponsor opens on a live book, with a capacity per tranche. Deposits wait in escrow and are accepted at the next mark, at that mark's share price, up to the capacity.",
    related: ["subscriptionWindow", "mark"],
  },
  {
    id: "redemptionNotice",
    term: "Redemption notice",
    short: "The wait before a Junior redemption settles, set in the charter. Notice is not a gate: a request is always accepted and settles at NAV at the first mark on or after its eligible time.",
    long: "Senior has no notice period: a Senior request settles at the next mark. Claims are never blocked by a pause or a kill.",
    related: ["junior", "mark"],
  },
  {
    id: "stockToken",
    term: "Stock Token",
    short: "A token on Robinhood Chain that tracks a listed stock. Books hedge with Stock Tokens; they are long-only, so they can only offset a short position.",
    long: "Stock Tokens and stock-perp books are not offered to US persons.",
    related: ["hedgeBand", "perp"],
  },
  {
    id: "perp",
    term: "Perp",
    short: "A perpetual future: a contract that follows an asset's price with no expiry date. Traders go long or short with margin, and funding payments keep it close to the underlying price.",
    related: ["marketMaker", "insuranceFund"],
  },
  {
    id: "marketMaker",
    term: "Market maker",
    short: "A trader that keeps both a buy quote (bid) and a sell quote (ask) in a market, earning the spread and fees while managing the inventory it ends up holding.",
    related: ["bookrunnerAgent", "mandate"],
  },
  {
    id: "bookrunnerAgent",
    term: "Bookrunner agent",
    short: "Software that quotes and hedges a book. Bookrunner agents quote the book under its mandate; their keys can only take the actions the mandate allows.",
    long: "An agent operator stakes a BKRN bond sized to the inventory tier the agent runs.",
    related: ["mandate", "marketMaker"],
  },
  {
    id: "insuranceFund",
    term: "Insurance fund",
    short: "Capital that absorbs trader losses a liquidation could not cover in one market. Each book funds its market's insurance fund first, then its market-making inventory.",
    related: ["book", "perp"],
  },
  {
    id: "pullOracle",
    term: "Pull oracle",
    short: "Prices are signed off-chain and carried inside the transaction that needs them, instead of being pushed on-chain on a timer. An idle book costs close to no gas.",
    related: ["mark", "gas"],
  },
  {
    id: "usdc",
    term: "USDC",
    short: "A dollar stablecoin. Books are funded and settled in USDC. On testnet, a mock test USDC with an open mint stands in for it and has no value.",
    related: ["testnet"],
  },
  {
    id: "gas",
    term: "Gas",
    short: "The network fee every transaction pays, in ETH. On testnet, ETH is free from the faucet.",
    related: ["testnet", "wallet"],
  },
  {
    id: "testnet",
    term: "Testnet",
    short: "A practice network where tokens have no real value. Bookrunner currently runs on Robinhood Chain Testnet.",
    related: ["gas", "usdc"],
  },
  {
    id: "wallet",
    term: "Wallet",
    short: "An app or browser extension that holds your keys and signs transactions. Connecting shares your address only; every transaction asks for your approval.",
    related: ["gas"],
  },
];

export const GLOSSARY: Readonly<Record<GlossaryId, GlossaryEntry>> = Object.fromEntries(entries.map((e) => [e.id, e])) as Record<GlossaryId, GlossaryEntry>;

/** Display order (roughly: product, money, safety, chain basics). */
export const GLOSSARY_IDS: readonly GlossaryId[] = entries.map((e) => e.id);

export const isGlossaryId = (s: string): s is GlossaryId => Object.prototype.hasOwnProperty.call(GLOSSARY, s);

export function glossaryEntry(id: GlossaryId): GlossaryEntry {
  return GLOSSARY[id];
}

/** Anchor id for a term on the Learn page (`/learn#term-senior`). */
export const termAnchor = (id: GlossaryId): string => `term-${id}`;
