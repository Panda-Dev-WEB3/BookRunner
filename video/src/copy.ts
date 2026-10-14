export const SCENE_IDS = ["hook", "problem", "book", "charter", "mandate", "waterfall", "proof", "live", "next"] as const;
export type SceneId = (typeof SCENE_IDS)[number];
export const COPY = {
  hook: { line: "Every perp market needs capital before its first trade.", brand: "BookRunner", tagline: "Run the book." },
  problem: {
    title: "A new market needs two things on day one.",
    needs: ["An insurance fund", "Market-making inventory"],
    today: "Today that capital is ad hoc, opaque, and nobody underwrites it.",
  },
  book: {
    title: "One book per market.",
    allocators: "Capital allocators",
    senior: "Senior tranche", seniorNote: "First claim on fee flow · last loss",
    junior: "Junior tranche", juniorNote: "Residual fee flow · first loss",
    book: "The book",
    venue: ["Insurance fund", "Market-making inventory"],
    caption: "The book capitalises the market on the venue.",
  },
  charter: {
    title: "Chartered, not improvised.",
    sponsor: "Sponsor files a charter",
    fields: ["Underlying", "Venue", "Oracle plan", "Insurance-fund size", "Mandate", "Tranche terms"],
    committee: "Risk Committee",
    committeeNote: "Model-jury verdict + three bonded members",
    threshold: "2 of 3 to approve",
    stamp: "Approved",
    approved: "Approved charters become books.",
  },
  mandate: {
    title: "Agents quote it. Code holds the limits.",
    agent: "Agent",
    band: "Mandate",
    bid: "Bid",
    ask: "Ask",
    inventory: "Inventory",
    limits: ["Quote width", "Skew", "Inventory", "Hedge band", "Drawdown kill"],
    breach: "Breach → quotes cancelled, inventory flattened, keys revoked.",
  },
  waterfall: {
    title: "How the money moves.",
    feesLabel: "Fee flow",
    steps: ["Expenses", "Protocol carry · 10%", "Senior share", "Junior residual"],
    lossesLabel: "Losses",
    lossSteps: ["Junior", "Senior", "Backstop, up to the pool"],
  },
  proof: {
    title: "Proof, not promises.",
    items: ["NAV", "Inventory", "P&L", "Receipt root"],
    mark: "Mark",
    seal: "Signed",
    signed: "Every mark is signed and committed on-chain.",
    gas: "One transaction per book per period.",
  },
  live: {
    title: "Live today on Robinhood Chain testnet.",
    books: ["NVDA", "TSLA", "RHX5"],
    caption: "Three books marking on-chain, every period.",
    url: "bookrunner.tech/dashboard",
  },
  next: {
    /** The roadmap runs on one network: `network` labels the whole route, from today's testnet to the mainnet launch. */
    network: "Robinhood Chain",
    steps: ["Live on testnet", "Independent audit", "Guarded mainnet launch"],
    url: "bookrunner.tech",
    x: "@TryBookRunner",
    disclaimer: "Testnet software. Not an offer. Stock-perp books are not available to US persons.",
  },
} as const satisfies Record<SceneId, Record<string, string | readonly string[]>>;
