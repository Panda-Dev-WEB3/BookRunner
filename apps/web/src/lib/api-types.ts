// Types of the public API, inferred from the tRPC router (type-only import: no server code is
// bundled). Every USD / share amount is a 6-decimal string, share prices are decimal strings,
// DB timestamps are ISO strings and chain periods are unix seconds.
import type { AppRouter } from "@bookrunner/api/router";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type { AppRouter };
export type Outputs = inferRouterOutputs<AppRouter>;
export type Inputs = inferRouterInputs<AppRouter>;

export type BookListItem = Outputs["book"]["list"][number];
export type BookDetail = Outputs["book"]["get"];
export type NavSeriesOut = Outputs["book"]["nav"];
export type NavPointOut = NavSeriesOut["points"][number];
export type LiveNavOut = NonNullable<NavSeriesOut["live"]>;
export type LimitsOut = Outputs["book"]["limits"];
export type LimitsView = NonNullable<BookListItem["limits"]>;
export type MarksOut = Outputs["book"]["marks"];
export type MarkItem = MarksOut["items"][number];
export type MandateView = NonNullable<BookDetail["mandate"]>;
export type CharterView = NonNullable<BookDetail["charter"]>;
export type QuoteView = NonNullable<BookDetail["quote"]>;
export type SettlementItem = Outputs["settlements"]["list"]["items"][number];
export type RiskStateOut = Outputs["risk"]["state"];
export type KillItem = RiskStateOut["kills"][number];
export type CharterListItem = Outputs["charter"]["list"]["items"][number];
export type CharterDetail = Outputs["charter"]["get"];
export type CharterFileOut = Outputs["charter"]["file"];
export type CharterIssue = CharterFileOut["issues"][number];
export type CharterDraftInput = Inputs["charter"]["file"];
export type DecideOut = Outputs["charter"]["decide"];
export type SubscribeOut = Outputs["tranche"]["subscribe"];
export type RedeemOut = Outputs["tranche"]["redeem"];
export type ClaimOut = Outputs["tranche"]["claim"];
export type PositionOut = Outputs["tranche"]["position"];
export type AgentListOut = Outputs["agent"]["list"];
export type AgentKey = AgentListOut["keys"][number];
export type ReceiptProof = Outputs["receipts"]["proof"];
export type ReceiptsRootOut = Outputs["receipts"]["root"];
export type MarkRootOut = Extract<ReceiptsRootOut, { kind: "mark" }>;
export type OraclePricesOut = Outputs["oracle"]["prices"];
// low-gas mode (docs/LOW_GAS.md): signed prices, signed venue reports, one mark tx per book per period
export type OracleSignedOut = Outputs["oracle"]["signed"];
export type MarkScheduleOut = BookListItem["markSchedule"];
export type SignedPriceOut = NonNullable<BookDetail["signedPrice"]>;
export type VenueReportOut = NonNullable<BookDetail["venueReport"]>;
export type EventItem = Outputs["events"]["recent"]["items"][number];
export type PreparedTx = SubscribeOut["txs"][number];
