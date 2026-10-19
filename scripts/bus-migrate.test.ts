import { describe, expect, test } from "bun:test";
import { busNames } from "../packages/shared/src/queues";
import { type RedisSend, describeMigration, migratedMarkerKey, migrateBus, migrationPlan, queueMovingKey, valueTimestampMs } from "./bus-migrate";

/** In-memory Redis with the commands migrateBus uses (strings, and opaque other types). */
class FakeRedis implements RedisSend {
  readonly data = new Map<string, { type: string; value: string }>();
  readonly writes: string[] = [];
  set(k: string, value: string, type = "string") {
    this.data.set(k, { type, value });
  }
  async send(cmd: string, args: string[]): Promise<unknown> {
    const glob = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    switch (cmd) {
      case "SCAN":
        return ["0", [...this.data.keys()].filter((k) => glob(args[2] as string).test(k))];
      case "EXISTS":
        return this.data.has(args[0] as string) ? 1 : 0;
      case "TYPE":
        return this.data.get(args[0] as string)?.type ?? "none";
      case "GET":
        return this.data.get(args[0] as string)?.value ?? null;
      case "RENAMENX": {
        const [a, b] = args as [string, string];
        if (this.data.has(b) || !this.data.has(a)) return 0;
        this.data.set(b, this.data.get(a)!);
        this.data.delete(a);
        this.writes.push(`RENAMENX ${a} ${b}`);
        return 1;
      }
      case "RENAME": {
        const [a, b] = args as [string, string];
        this.data.set(b, this.data.get(a)!);
        this.data.delete(a);
        this.writes.push(`RENAME ${a} ${b}`);
        return "OK";
      }
      case "DEL":
        this.data.delete(args[0] as string);
        this.writes.push(`DEL ${args[0]}`);
        return 1;
      case "SET":
        this.set(args[0] as string, args[1] as string);
        this.writes.push(`SET ${args[0]}`);
        return "OK";
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  }
}

const n = busNames("testnet").KEYS;
const risk = (ts: number) => JSON.stringify({ state: "ok", meta: { bookId: 1, ts } });

describe("bus namespace migration (dev.ts runs it before any service starts)", () => {
  test("plan: legacy shared keys move to bkrn:<ns>:…, exactly where the new KEYS look; private and namespaced keys stay", () => {
    const keys = ["bkrn:risk:state:1", "bkrn:venue:report:1", "bkrn:venue:report:1:recent", "bkrn:oracle:last:NVDA", "bkrn:oracle:bundle", "bkrn:supervisor:status", "bkrn:alerts:state", "bkrn:api:cache:x", "bkrn:waterfall:nodist:1:5", "bkrn:backup:last", "bkrn:testnet:risk:state:1"];
    expect(Object.fromEntries(migrationPlan(keys, "testnet"))).toEqual({
      "bkrn:oracle:bundle": n.oracleBundle,
      "bkrn:oracle:last:NVDA": n.oracleLast("NVDA"),
      "bkrn:risk:state:1": n.riskState(1),
      "bkrn:supervisor:status": n.supervisorStatus,
      "bkrn:venue:report:1": n.venueReport(1),
      "bkrn:venue:report:1:recent": n.venueReportRecent(1),
    });
  });

  test("fresh start (first deploy): every legacy key and queue moves, private keys stay, the marker is written", async () => {
    const r = new FakeRedis();
    r.set("bkrn:risk:state:1", risk(1_000));
    r.set("bkrn:venue:report:1", JSON.stringify({ bookId: 1, asOf: 100 }));
    r.set("bkrn:venue:report:1:recent", "[list]", "list");
    r.set("bkrn:alerts:state", "{}");
    r.set("bull:bkrn-venue-ops:wait", "[list]", "list");
    r.set("bull:bkrn-venue-ops:7", "{job}", "hash");
    r.set("bull:bkrn-marks:meta", "{}", "hash");
    const m = await migrateBus(r, "testnet", { now: 5 });
    expect(m.moved.sort()).toEqual([`bkrn:risk:state:1 -> ${n.riskState(1)}`, `bkrn:venue:report:1 -> ${n.venueReport(1)}`, `bkrn:venue:report:1:recent -> ${n.venueReportRecent(1)}`].sort());
    expect(m.queuesMoved).toEqual(["bull:bkrn-venue-ops -> bull:bkrn-testnet-venue-ops (2 keys)", "bull:bkrn-marks -> bull:bkrn-testnet-marks (1 keys)"]);
    expect(r.data.get(n.riskState(1))?.value).toBe(risk(1_000));
    expect(r.data.has("bull:bkrn-testnet-venue-ops:7")).toBe(true);
    expect(r.data.has("bkrn:alerts:state")).toBe(true);
    expect(r.data.has("bkrn:risk:state:1")).toBe(false);
    expect(JSON.parse(r.data.get(migratedMarkerKey("testnet"))!.value)).toMatchObject({ v: 1, at: 5, moved: 3, queues: 2 });
    expect(describeMigration("testnet", m)[0]).toContain("moved 3 key(s)");
  });

  test("already migrated: the marker makes it a no-op (no read of the keys, no write)", async () => {
    const r = new FakeRedis();
    r.set(migratedMarkerKey("testnet"), "{}");
    r.set("bkrn:risk:state:1", risk(1)); // e.g. an old-code process wrote a legacy key later: left alone
    const m = await migrateBus(r, "testnet");
    expect(m.skipped).toBe(true);
    expect(r.writes).toEqual([]);
    expect(describeMigration("testnet", m)).toEqual([`bus namespace "testnet": already migrated (${migratedMarkerKey("testnet")})`]);
  });

  test("partial (new code already ran once, no marker): never overwrites a newer value; older targets replaced; no timestamp = conflict, target kept", async () => {
    const r = new FakeRedis();
    // risk wrote the new name AFTER the legacy one: the new one is newer -> kept, legacy deleted
    r.set("bkrn:risk:state:1", risk(1_000));
    r.set(n.riskState(1), risk(2_000));
    // the legacy venue report is newer than the one under the new name -> it replaces it
    r.set("bkrn:venue:report:2", JSON.stringify({ bookId: 2, asOf: 300 }));
    r.set(n.venueReport(2), JSON.stringify({ bookId: 2, asOf: 200 }));
    // no timestamp to compare (a list): the target wins, the conflict is logged, the legacy key stays
    r.set("bkrn:venue:report:2:recent", "[old]", "list");
    r.set(n.venueReportRecent(2), "[new]", "list");
    // a legacy key whose target is absent still moves
    r.set("bkrn:oracle:last:NVDA", JSON.stringify({ publishedAt: 50 }));
    // a queue already in use under the new name: legacy jobs left, conflict logged
    r.set("bull:bkrn-webhooks:1", "{job}", "hash");
    r.set("bull:bkrn-testnet-webhooks:2", "{job}", "hash");
    const m = await migrateBus(r, "testnet");
    expect(r.data.get(n.riskState(1))?.value).toBe(risk(2_000));
    expect(r.data.has("bkrn:risk:state:1")).toBe(false);
    expect(m.keptNewer).toEqual([`${n.riskState(1)} (newer than legacy bkrn:risk:state:1)`]);
    expect(JSON.parse(r.data.get(n.venueReport(2))!.value).asOf).toBe(300);
    expect(m.replacedOlder[0]).toContain("bkrn:venue:report:2 ->");
    expect(r.data.get(n.venueReportRecent(2))?.value).toBe("[new]");
    expect(r.data.get("bkrn:venue:report:2:recent")?.value).toBe("[old]");
    expect(m.conflicts).toEqual([`bkrn:venue:report:2:recent -> ${n.venueReportRecent(2)} (target exists, no timestamp to compare: target kept, legacy key left in place)`]);
    expect(m.moved).toEqual([`bkrn:oracle:last:NVDA -> ${n.oracleLast("NVDA")}`]);
    expect(m.queueConflicts[0]).toContain("bull:bkrn-webhooks (1 keys) -> bull:bkrn-testnet-webhooks");
    expect(r.data.has("bull:bkrn-webhooks:1")).toBe(true);
    // a blocked queue is not a completed move: no marker, the next start retries (and logs it again)
    expect(m.incomplete).toBe(true);
    expect(r.data.has(migratedMarkerKey("testnet"))).toBe(false);
    expect(describeMigration("testnet", m)).toContain("  INCOMPLETE: no marker written, the next start retries what is left");
    const again = await migrateBus(r, "testnet");
    expect([again.skipped, again.incomplete, again.queueConflicts.length]).toEqual([false, true, 1]);
    // once the conflict is resolved by hand, the next start completes and writes the marker
    r.data.delete("bull:bkrn-testnet-webhooks:2");
    const done = await migrateBus(r, "testnet");
    expect([done.incomplete, r.data.has("bull:bkrn-testnet-webhooks:1"), r.data.has(migratedMarkerKey("testnet"))]).toEqual([false, true, true]);
    expect((await migrateBus(r, "testnet")).skipped).toBe(true);
  });

  test("an interrupted queue move resumes at the next start (marked in progress), never stranded", async () => {
    const r = new FakeRedis();
    r.set("bull:bkrn-marks:wait", "[list]", "list");
    r.set("bull:bkrn-marks:1", "{job}", "hash");
    r.set("bull:bkrn-marks:2", "{job}", "hash");
    // Redis drops after the first rename of the queue
    let renames = 0;
    const send = r.send.bind(r);
    r.send = async (cmd, args) => {
      if (cmd === "RENAMENX" && args[0]?.startsWith("bull:") && ++renames === 2) throw new Error("connection lost");
      return send(cmd, args);
    };
    await expect(migrateBus(r, "testnet")).rejects.toThrow("connection lost");
    expect(r.data.has(queueMovingKey("testnet", "marks"))).toBe(true);
    expect(r.data.has(migratedMarkerKey("testnet"))).toBe(false);
    r.send = send; // Redis back: dev.ts retries
    const m = await migrateBus(r, "testnet");
    expect(m.incomplete).toBe(false);
    expect(m.queuesMoved[0]).toContain("resumed");
    expect(["bull:bkrn-testnet-marks:wait", "bull:bkrn-testnet-marks:1", "bull:bkrn-testnet-marks:2"].every((k) => r.data.has(k))).toBe(true);
    expect([...r.data.keys()].some((k) => k.startsWith("bull:bkrn-marks:"))).toBe(false);
    expect(r.data.has(queueMovingKey("testnet", "marks"))).toBe(false);
    expect(r.data.has(migratedMarkerKey("testnet"))).toBe(true);
  });

  test("a legacy key that expires before its move is reported as expired (not a conflict) and does not block the marker", async () => {
    const r = new FakeRedis();
    r.set("bkrn:agent:hb:1", "1700000000000");
    const send = r.send.bind(r);
    r.send = async (cmd, args) => {
      if (cmd === "RENAMENX" && args[0] === "bkrn:agent:hb:1") {
        r.data.delete("bkrn:agent:hb:1"); // the TTL fires between the scan and the rename
        return 0;
      }
      return send(cmd, args);
    };
    const m = await migrateBus(r, "testnet");
    expect(m.expired).toEqual(["bkrn:agent:hb:1 (expired before its move)"]);
    expect([m.conflicts, m.incomplete]).toEqual([[], false]);
    expect(r.data.has(migratedMarkerKey("testnet"))).toBe(true);
  });

  test("dry run writes nothing; timestamps: ts / meta.ts / asOf / publishedAt / bare ms", async () => {
    const r = new FakeRedis();
    r.set("bkrn:risk:state:1", risk(1));
    const m = await migrateBus(r, "testnet", { apply: false });
    expect(m.moved).toHaveLength(1);
    expect(r.writes).toEqual([]);
    expect(r.data.has(migratedMarkerKey("testnet"))).toBe(false);
    expect([valueTimestampMs(JSON.stringify({ ts: 1_700_000_000_000 })), valueTimestampMs(risk(5)), valueTimestampMs(JSON.stringify({ asOf: 10 })), valueTimestampMs(JSON.stringify({ publishedAt: 20 })), valueTimestampMs("1700000000000"), valueTimestampMs("{}"), valueTimestampMs(null)]).toEqual([1_700_000_000_000, 5_000, 10_000, 20_000, 1_700_000_000_000, null, null]);
  });
});
