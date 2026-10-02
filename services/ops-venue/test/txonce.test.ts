import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { ChainPort, SentTx, TxState, WriteOpts } from "../src/chain";
import { sendOnce } from "../src/worker/txonce";

const prior: SentTx = { hash: `0x${"11".repeat(32)}` as Hex, nonce: 41, at: 0 };

async function run(state: TxState | null) {
  const chain = { txState: async () => state as TxState } as unknown as ChainPort;
  const sent: WriteOpts[] = [];
  const recorded: SentTx[] = [];
  const r = await sendOnce(chain, state === null ? undefined : prior, (tx) => recorded.push(tx), async (o) => {
    sent.push(o);
    o.onSent?.({ hash: `0x${"22".repeat(32)}` as Hex, nonce: o.nonce ?? 42, at: 1 });
    return "value";
  });
  return { r, sent, recorded };
}

describe("sendOnce (at-most-once saga writes)", () => {
  test("no prior tx: sends and records it before the receipt wait", async () => {
    const { r, sent, recorded } = await run(null);
    expect(r).toEqual({ kind: "sent", value: "value" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.nonce).toBeUndefined();
    expect(recorded.map((x) => x.nonce)).toEqual([42]);
  });

  test("prior tx mined: reused, nothing sent", async () => {
    const { r, sent } = await run("success");
    expect(r).toEqual({ kind: "mined", hash: prior.hash });
    expect(sent).toHaveLength(0);
  });

  test("prior tx pending: wait, nothing sent", async () => {
    const { r, sent } = await run("pending");
    expect(r.kind).toBe("pending");
    expect(sent).toHaveLength(0);
  });

  test("prior tx dropped: re-sent with the SAME nonce (only one can ever be mined)", async () => {
    const { r, sent } = await run("dropped");
    expect(r.kind).toBe("sent");
    expect(sent[0]?.nonce).toBe(41);
  });

  test("prior tx replaced or reverted: re-sent with a fresh nonce", async () => {
    for (const st of ["replaced", "reverted"] as const) {
      const { r, sent } = await run(st);
      expect(r.kind).toBe("sent");
      expect(sent[0]?.nonce).toBeUndefined();
    }
  });
});
