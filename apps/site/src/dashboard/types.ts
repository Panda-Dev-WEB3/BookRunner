// Types of the public API, inferred from the tRPC router (type-only import: no server code is
// bundled). USD / share amounts are 6-decimal strings, share prices decimal strings, DB timestamps
// ISO strings and chain periods unix seconds.
import type { AppRouter } from "@bookrunner/api/router";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type Outputs = inferRouterOutputs<AppRouter>;
export type Inputs = inferRouterInputs<AppRouter>;

/** "book.list" | "tranche.subscribe" | ... */
export type ProcPath = { [R in keyof Outputs & string]: `${R}.${keyof Outputs[R] & string}` }[keyof Outputs & string];
export type ProcOutput<P extends ProcPath> = P extends `${infer R}.${infer Q}`
  ? R extends keyof Outputs
    ? Q extends keyof Outputs[R]
      ? Outputs[R][Q]
      : never
    : never
  : never;
export type ProcInput<P extends ProcPath> = P extends `${infer R}.${infer Q}`
  ? R extends keyof Inputs
    ? Q extends keyof Inputs[R]
      ? Inputs[R][Q]
      : never
    : never
  : never;

export type BookListItem = Outputs["book"]["list"][number];
export type BookDetail = Outputs["book"]["get"];
export type NavSeries = Outputs["book"]["nav"];
export type NavPoint = NavSeries["points"][number];
export type LimitsOut = Outputs["book"]["limits"];
export type LimitsView = NonNullable<BookListItem["limits"]>;
export type MarksOut = Outputs["book"]["marks"];
export type MarkItem = MarksOut["items"][number];
export type MandateView = NonNullable<BookDetail["mandate"]>;
export type CharterView = NonNullable<BookDetail["charter"]>;
export type MarkSchedule = BookListItem["markSchedule"];
export type SettlementsOut = Outputs["settlements"]["list"];
export type SettlementItem = SettlementsOut["items"][number];
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
export type PositionTranche = PositionOut["tranches"][number];
export type AgentListOut = Outputs["agent"]["list"];
export type AgentKey = AgentListOut["keys"][number];
export type RegisterOut = Outputs["agent"]["register"];
export type RevokeOut = Outputs["agent"]["revoke"];
export type ReceiptsRootOut = Outputs["receipts"]["root"];
export type EventItem = Outputs["events"]["recent"]["items"][number];
export type PreparedTx = SubscribeOut["txs"][number];

export type TrancheName = "senior" | "junior";

/** GET /health of the API. */
export interface Health {
  ok: boolean;
  chainId: number | null;
  deployment: boolean;
  db: string | null;
  redis: string | null;
  procedures: string[] | null;
}
