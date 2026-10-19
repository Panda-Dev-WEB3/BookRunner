// Per-stack bus namespace (queues.ts): two stacks never share a channel, key or queue, and a message stamped with
// another stack's namespace is dropped by the subscriber.
import { describe, expect, test } from "bun:test";
import { BUS_NS, busDropper, busForeign, busJson, busNames, busNamespace } from "../src/queues";

describe("bus namespace", () => {
  test("derived from BKRN_BUS_NS, else NETWORK, else CHAIN_ID; malformed refused", () => {
    expect(busNamespace({})).toBe("devnet");
    expect(busNamespace({ CHAIN_ID: "46630" })).toBe("testnet");
    expect(busNamespace({ CHAIN_ID: "4663" })).toBe("mainnet");
    expect(busNamespace({ CHAIN_ID: "1" })).toBe("chain1");
    expect(busNamespace({ NETWORK: "testnet", CHAIN_ID: "46630" })).toBe("testnet");
    expect(busNamespace({ NETWORK: "testnet", BKRN_BUS_NS: "testnet-live" })).toBe("testnet-live");
    expect(() => busNamespace({ BKRN_BUS_NS: "Bad NS" })).toThrow("BKRN_BUS_NS");
    expect(BUS_NS).toBe(busNamespace(process.env));
  });

  test("every channel, key and queue of one stack differs from the other's", () => {
    const pub = busNames("testnet");
    const live = busNames("testnet-live");
    expect(pub.CHANNELS.kill(1)).toBe("bkrn:testnet:risk:kill:1");
    expect(live.CHANNELS.kill(1)).toBe("bkrn:testnet-live:risk:kill:1");
    expect(live.CHANNELS.killPattern).toBe("bkrn:testnet-live:risk:kill:*");
    // the public stack's kill pattern does not match a live kill channel (and vice versa)
    const matches = (pattern: string, ch: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(ch);
    expect(matches(pub.CHANNELS.killPattern, live.CHANNELS.kill(1))).toBe(false);
    expect(matches(live.CHANNELS.killPattern, pub.CHANNELS.kill(1))).toBe(false);
    expect(matches(pub.CHANNELS.killPattern, pub.CHANNELS.kill(7))).toBe(true);
    const flat = (n: ReturnType<typeof busNames>) => [
      ...Object.values(n.QUEUES),
      n.CHANNELS.oraclePrice("NVDA"), n.CHANNELS.quotes(1), n.CHANNELS.fills(1), n.CHANNELS.riskState(1), n.CHANNELS.kill(1), n.CHANNELS.domainEvents,
      n.KEYS.oracleLast("NVDA"), n.KEYS.oracleBundle, n.KEYS.venueReport(1), n.KEYS.venueReportRecent(1), n.KEYS.riskState(1), n.KEYS.agentHeartbeat(1),
      n.KEYS.agentQuote(1), n.KEYS.liveNav(1), n.KEYS.venueSymbolIssues, n.KEYS.oracleVenueFeed, n.KEYS.builderFeedStatus, n.KEYS.supervisorStatus,
    ];
    const a = flat(pub);
    const b = new Set(flat(live));
    expect(a.filter((x) => b.has(x))).toEqual([]);
    for (const q of Object.values(pub.QUEUES)) expect(q).toMatch(/^bkrn-testnet-/);
  });

  test("a kill published on one namespace is ignored by the other (stamped messages; logged once)", () => {
    const kill = busJson({ bookId: 1, ts: 1, reason: "DRAWDOWN", breaches: [] }, "testnet");
    expect(JSON.parse(kill).ns).toBe("testnet");
    expect(busForeign(kill, "testnet")).toBeNull();
    expect(busForeign(kill, "testnet-live")).toBe("testnet");
    expect(busForeign(JSON.parse(kill), "testnet-live")).toBe("testnet");
    expect(busForeign("{\"bookId\":1}", "testnet-live")).toBeNull(); // no ns: only this stack's publishers write its channels
    expect(busForeign("not json", "testnet")).toBeNull();
    const warned: unknown[] = [];
    const drop = busDropper((msg, meta) => warned.push([msg, meta]), "testnet-live");
    expect(drop("bkrn:testnet-live:risk:kill:1", kill)).toBe(true);
    expect(drop("bkrn:testnet-live:risk:kill:1", kill)).toBe(true);
    expect(drop("bkrn:testnet-live:risk:kill:1", busJson({ bookId: 1 }, "testnet-live"))).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toEqual(["bus message from another stack dropped (namespace mismatch)", { channel: "bkrn:testnet-live:risk:kill:1", ns: "testnet", mine: "testnet-live" }]);
  });
});
