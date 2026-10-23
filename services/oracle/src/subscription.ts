// The oracle's log subscription (RPC budget, deploy/server/MAINNET.md "RPC budget"): AnswerUpdated / NewRound of
// every feed's current aggregator (and the sequencer feed's) and UIMultiplierUpdated of every Stock Token, over the
// shared LogSubscription. It only triggers: a feed event starts a Chainlink pass at the next tick, a token event also
// forces that token's state into it. The pass itself (one aggregate3) and every staleness rule are unchanged; a
// safety pass still runs without events (ORACLE_CHAINLINK_EVENT_READ_MS, and the token states every 60 s).
import { type LogFilter, type SubscriptionLog, uiMultiplierUpdatedEvent } from "@bookrunner/shared";
import { type Address, type Hex, toEventSelector } from "viem";
import type { ChainlinkSource } from "./sources/chainlink";

/** OffchainAggregator / AccessControlledOffchainAggregator events (Chainlink AggregatorInterface). */
export const ANSWER_UPDATED_TOPIC = toEventSelector("AnswerUpdated(int256,uint256,uint256)");
export const NEW_ROUND_TOPIC = toEventSelector("NewRound(uint256,address,uint256)");
export const UI_MULTIPLIER_UPDATED_TOPIC = toEventSelector(uiMultiplierUpdatedEvent);

/** The filter: every event source (aggregators) and Stock Token, topic0 one of the three events. */
export function oracleLogFilter(sources: ReadonlyMap<Address, Address>, tokens: readonly Address[]): LogFilter {
  const address = [...new Set([...sources.values(), ...tokens].map((a) => a.toLowerCase()))] as Address[];
  return { address, topics: [[ANSWER_UPDATED_TOPIC, NEW_ROUND_TOPIC, UI_MULTIPLIER_UPDATED_TOPIC] as Hex[]] };
}

/** Routes notifications to the Chainlink source: a token's UIMultiplierUpdated -> notifyToken, an aggregator event -> notifyFeed. */
export function routeOracleLogs(logs: readonly SubscriptionLog[], chainlink: Pick<ChainlinkSource, "notifyFeed" | "notifyToken">, tokens: readonly Address[]): void {
  const byAddr = new Map(tokens.map((t) => [t.toLowerCase(), t]));
  for (const l of logs) {
    const topic = l.topics[0]?.toLowerCase();
    const token = byAddr.get(l.address.toLowerCase());
    if (token && topic === UI_MULTIPLIER_UPDATED_TOPIC.toLowerCase()) chainlink.notifyToken(token);
    else if (topic === ANSWER_UPDATED_TOPIC.toLowerCase() || topic === NEW_ROUND_TOPIC.toLowerCase()) chainlink.notifyFeed();
  }
}
