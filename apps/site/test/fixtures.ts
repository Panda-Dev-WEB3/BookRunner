// Trimmed payloads of the live testnet API (shapes as served by services/api).
import type { BookListItem, MarkItem, PositionOut, SettlementItem } from "../src/dashboard/types";

export const bookNvda = {
  bookId: 1,
  charterId: 1,
  name: null,
  symbol: "PERP_NVDA_USDC",
  venue: "orderly",
  state: "Live",
  underlying: "0x0000000000000000000000005443c42fe58b9ef5f8fde91b2dc87b63d78f8064",
  subscriptionEnds: "2026-10-02T13:41:32.000Z",
  createdAt: "2026-10-02T13:31:32.000Z",
  components: {
    book: "0xa6cE5A0d4aA9E945C04f3441c83964575a7ddD6B",
    senior: "0xFe4ac74d2275ca1bCef70146Cca16d07F7E5ade9",
    junior: "0x4d15C8c8be3682ab440AF7Ab13aBA9Fdf94d82e3",
    vault: "0xf56176634b2820D585a4EE461e8f6b0310416161",
    mandate: "0x36e0D0FAA8eD344647d8eFc6eE04030587Ee735a",
    router: "0x2BD5F8d58321488883DF35E66f5F8B636766c7C8",
    desk: "0x49426bE8D319Ab46caa67f2b4D9A40dA54d83Cc3",
    adapter: "0xE60215841c272baf93EEE0fc92fE447261B31181",
  },
  navUsd: "134854.933474",
  seniorNavUsd: "74552.031431",
  juniorNavUsd: "60302.902043",
  seniorSharePrice: "1.014313352803",
  juniorSharePrice: "1.914377842635",
  lastMark: { markId: 338, periodEnd: 1791349200, periodEndAt: "2026-10-07T05:00:00.000Z", navUsd: "134854.933474", committedAt: "2026-10-07T05:02:34.000Z" },
  liveNav: { navUsd: "135025.864468", seniorNavUsd: "74552.031431", juniorNavUsd: "60302.902043", deployedValueUsd: null, drawdownBps: 0, ts: "2026-10-07T05:45:27.240Z", source: "live" },
  limits: { state: "ok", inventoryUtil: 0.108428, skewUtil: 0.3557910765523761, hedgeRatioBps: 9104, drawdownBps: 0, offHours: false, breaches: [], netExposureUsd: -5421.433281, liveNavUsd: 135025.864468, ts: "2026-10-07T05:45:27.240Z", source: "live" },
  markSchedule: { intervalSeconds: 3600, cadence: "hourly", lastPeriodEnd: 1791349200, nextPeriodEnd: 1791352800, nextPeriodEndAt: "2026-10-07T06:00:00.000Z", status: "scheduled", secondsUntil: 869 },
} as unknown as BookListItem;

export const bookRhx5 = {
  ...bookNvda,
  bookId: 3,
  charterId: 3,
  symbol: "RHX5-PERP",
  venue: "pool_engine",
  navUsd: "142012.981655",
  lastMark: { markId: 337, periodEnd: 1791345600, periodEndAt: "2026-10-07T04:00:00.000Z", navUsd: "142012.981655", committedAt: "2026-10-07T04:02:28.000Z" },
  liveNav: null,
  limits: null,
} as unknown as BookListItem;

export const markItem = {
  markId: 338,
  bookId: 1,
  periodEnd: 1791349200,
  periodEndAt: "2026-10-07T05:00:00.000Z",
  navUsd: "134854.933474",
  deployedValueUsd: "134815.535262",
  seniorNavUsd: "74552.031431",
  juniorNavUsd: "60302.902043",
  seniorSharePrice: "1.014313352803",
  juniorSharePrice: "1.914377842635",
  pnlUsd: "243.641296",
  flowNonce: 20,
  receiptsRoot: "0xf90ee11c0e5016960225e5a84669c8898d1d605b466b29bc86dd4f43c30f9573",
  inventoryRoot: "0x221a251fc9bb3b88f1c64f58e48846488ebcbeac007fe3ca369dadc447fa9567",
  pnlJsonHash: "0x965170a8c09e1bafac58f36c7aaf3f364a1a45153ecc38fdfaec38ebdb4e26a5",
  signer: "0x22e42caaf222603beacf0f0001e2a00a5756fd8f",
  txHash: "0x5bb3ac9f0f79fbc7fb8d431c3777e49a314ab80822616a1715a466b0490ef57e",
  appliedTx: "0x5bb3ac9f0f79fbc7fb8d431c3777e49a314ab80822616a1715a466b0490ef57e",
  committedAt: "2026-10-07T05:02:34.000Z",
  pnl: { pnl: { feeFlowUsd: "14.639670", markPnlUsd: "243.641296" } },
  signature: "0xd5",
} as unknown as MarkItem;

export const settlements = [
  { id: 1519, bookId: 1, ts: "2026-10-07T05:01:41.000Z", period: 1791349200, source: "distribution", grossUsd: "17.266299", expensesUsd: "1.000000", carryUsd: "1.626629", seniorUsd: "8.783802", juniorUsd: "5.855868", txHash: "0x9cf6c73d728ba65b0c71ab2efb7df89c7cde333b0c1a6854bd71516eacc160d1", logIndex: 0 },
  { id: 1514, bookId: 1, ts: "2026-10-07T05:00:23.000Z", period: null, source: "venue_taker_share", grossUsd: "17.266299", expensesUsd: "0.000000", carryUsd: "0.000000", seniorUsd: "0.000000", juniorUsd: "0.000000", txHash: "0x847bd8c1e93fc00b1117ccba6e2e074cb2fe52e3582c8188f364aa621816cfa2", logIndex: 1 },
] as unknown as SettlementItem[];

const notice = "Notice is not a gate: the request is always accepted and settles at the first mark on or after the eligible time, at that mark's share price.";

export const position = {
  bookId: 1,
  wallet: "0xa47B1aE8283C5DCAC9f8800e08F81928482AC915",
  tranches: [
    {
      tranche: "senior",
      address: "0xFe4ac74d2275ca1bCef70146Cca16d07F7E5ade9",
      shares: "1000.000000",
      sharePrice: "1.014313352802721088",
      navValueUsd: "1014.313352",
      committedUsd: "250.000000",
      depositsOpen: true,
      claimableAllocation: { shares: "0.000000", refundUsd: "0.000000" },
      claimableRedemptionUsd: "0.000000",
      redemptions: [
        { requestId: "497597", shares: "100.000000", requestedAt: "2026-10-07T04:10:00.000Z", eligibleAt: "2026-10-07T04:10:00.000Z", settlesAtPeriodEnd: "2026-10-07T05:00:00.000Z", honouredMarkId: 338, assetsUsd: "101.431335", status: "claimable", requestTx: "0x01" },
      ],
      notice,
    },
    {
      tranche: "junior",
      address: "0x4d15C8c8be3682ab440AF7Ab13aBA9Fdf94d82e3",
      shares: "0.000000",
      sharePrice: "1.914377842634920634",
      navValueUsd: "0.000000",
      committedUsd: "0.000000",
      depositsOpen: true,
      claimableAllocation: { shares: "12600.000000", refundUsd: "0.000000" },
      claimableRedemptionUsd: "0.000000",
      redemptions: [],
      notice,
    },
  ],
  totals: { navValueUsd: "1014.313352", claimableRedemptionUsd: "0.000000" },
  source: "chain",
} as unknown as PositionOut;
