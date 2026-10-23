// PoolEngine (2026-10 liquidation keeper) event handlers: keep engine_positions, the keeper's trader set, from the
// engine's own events (no chain scan). Trade carries the position size after the trade (newSize; forceClose emits a
// Trade with newSize 0), Liquidation closes the whole position, ClosedOut is a wind-down / settle close-out, and
// MarginChanged registers a trader before the first trade (size unchanged). Idempotent: a row is only replaced by a
// later log (block, logIndex), so a re-applied range changes nothing.
import { arg } from "./convert";
import type { Handler } from "./handlers";

const pos = (f: (args: Record<string, unknown>) => { trader: string; sizeRaw: string | null }): Handler =>
  async ({ log, store }) => {
    const { trader, sizeRaw } = f(log.args);
    await store.upsertEnginePosition({ marketId: arg.num(log.args, "marketId"), trader, sizeRaw, lastBlock: Number(log.blockNumber), lastLogIndex: log.logIndex });
  };

export const ENGINE_HANDLERS: Record<string, Handler> = {
  "engine.Trade": pos((a) => ({ trader: arg.addr(a, "trader"), sizeRaw: arg.big(a, "newSize").toString() })),
  "engine.MarginChanged": pos((a) => ({ trader: arg.addr(a, "trader"), sizeRaw: null })),
  "engine.Liquidation": pos((a) => ({ trader: arg.addr(a, "trader"), sizeRaw: "0" })),
  "engine.ClosedOut": pos((a) => ({ trader: arg.addr(a, "trader"), sizeRaw: "0" })),
};
