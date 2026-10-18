import { describe, expect, test } from "bun:test";
import { busNames } from "../packages/shared/src/queues";
import { migrationPlan } from "./bus-migrate";

describe("bus namespace migration (one-off, running stacks)", () => {
  test("legacy shared keys move to bkrn:<ns>:…, exactly where the new KEYS look; private and namespaced keys stay", () => {
    const keys = [
      "bkrn:risk:state:1",
      "bkrn:venue:report:1",
      "bkrn:venue:report:1:recent",
      "bkrn:oracle:last:NVDA",
      "bkrn:oracle:bundle",
      "bkrn:supervisor:status",
      "bkrn:alerts:state", // alerts' own
      "bkrn:api:cache:x", // API cache
      "bkrn:waterfall:nodist:1:5",
      "bkrn:backup:last",
      "bkrn:testnet:risk:state:1", // already namespaced
    ];
    const plan = migrationPlan(keys, "testnet");
    const n = busNames("testnet").KEYS;
    expect(Object.fromEntries(plan)).toEqual({
      "bkrn:oracle:bundle": n.oracleBundle,
      "bkrn:oracle:last:NVDA": n.oracleLast("NVDA"),
      "bkrn:risk:state:1": n.riskState(1),
      "bkrn:supervisor:status": n.supervisorStatus,
      "bkrn:venue:report:1": n.venueReport(1),
      "bkrn:venue:report:1:recent": n.venueReportRecent(1),
    });
  });
});
