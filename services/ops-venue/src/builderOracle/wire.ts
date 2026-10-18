// Wiring of the live builder price push (main.ts): gating, the pushing account / key, the WebSocket client, and the
// two inputs of the oracle venue feed (channel + periodic key re-read). Redis is injected so tests drive it with fakes.
import { type BuilderFeedStatusMsg, KEYS, type Logger } from "@bookrunner/shared";
import type { Ed25519Key } from "../orderly/auth";
import type { TrackedBook } from "../worker/context";
import { BuilderPriceFeed, builderFeedTargets } from "./feed";
import { BuilderOracleSocket, resolveOracleWsDomain, type WebSocketFactory } from "./socket";

export interface BuilderFeedEnv {
  ORDERLY_MODE: "mock" | "live";
  ORDERLY_BASE_URL: string;
  ORDERLY_SYMBOL_PRICE_SOURCE: "builder" | "chainlink";
  OPS_BUILDER_PRICE_PUSH: boolean;
  ORDERLY_ORACLE_WS_URL?: string | undefined;
  ORDERLY_ORACLE_ACCOUNT_ID?: string | undefined;
  ORDERLY_ORACLE_KEY_SECRET?: string | undefined;
  OPS_BUILDER_PRICE_INTERVAL_MS: number;
  OPS_BUILDER_PRICE_MAX_AGE_MS: number;
  OPS_BUILDER_ORACLE_RECONNECT_MS: number;
  OPS_BUILDER_ORACLE_MAX_RECONNECT_MS: number;
  OPS_BUILDER_ORACLE_IDLE_MS: number;
  OPS_BUILDER_ORACLE_LIVENESS_MS: number;
  OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS: number;
}

/** The push runs only with ORDERLY_MODE=live, OPS_BUILDER_PRICE_PUSH and builder-priced listings. */
export function builderPushEnabled(env: Pick<BuilderFeedEnv, "ORDERLY_MODE" | "OPS_BUILDER_PRICE_PUSH" | "ORDERLY_SYMBOL_PRICE_SOURCE">): boolean {
  return env.ORDERLY_MODE === "live" && env.OPS_BUILDER_PRICE_PUSH && env.ORDERLY_SYMBOL_PRICE_SOURCE === "builder";
}

/** Redis the wiring needs: GET (key re-read) and a subscriber connection (channel). */
export interface FeedRedis {
  get(key: string): Promise<string | null>;
}
export interface FeedSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", cb: (channel: string, message: string) => void): unknown;
}

export interface BuilderFeedDeps {
  env: BuilderFeedEnv;
  log: Logger;
  builderAccountId: string;
  builderKey: Ed25519Key;
  keyFromSecret: (s: string) => Promise<Ed25519Key>;
  books: () => TrackedBook[];
  redis: FeedRedis;
  sub: FeedSubscriber;
  publishStatus: (s: BuilderFeedStatusMsg) => Promise<void>;
  signal: AbortSignal;
  webSocket?: WebSocketFactory;
}

export interface BuilderFeedHandle {
  feed: BuilderPriceFeed;
  socket: BuilderOracleSocket | null;
  done: Promise<void>;
  stop(): Promise<void>;
}

/** null when the push is off (mock mode, OPS_BUILDER_PRICE_PUSH=0, chainlink-priced listings). */
export async function startBuilderPriceFeed(d: BuilderFeedDeps): Promise<BuilderFeedHandle | null> {
  const { env, log } = d;
  if (!builderPushEnabled(env)) return null;
  const domain = resolveOracleWsDomain(env.ORDERLY_BASE_URL, env.ORDERLY_ORACLE_WS_URL);
  // loadOpsEnv already refuses one of ORDERLY_ORACLE_ACCOUNT_ID / ORDERLY_ORACLE_KEY_SECRET without the other
  const key = env.ORDERLY_ORACLE_KEY_SECRET ? await d.keyFromSecret(env.ORDERLY_ORACLE_KEY_SECRET) : d.builderKey;
  const accountId = (env.ORDERLY_ORACLE_ACCOUNT_ID ?? d.builderAccountId).toLowerCase();
  let feed: BuilderPriceFeed | null = null;
  const socket = domain
    ? new BuilderOracleSocket({
        domain,
        accountId,
        key,
        log,
        reconnectMs: env.OPS_BUILDER_ORACLE_RECONNECT_MS,
        maxReconnectMs: env.OPS_BUILDER_ORACLE_MAX_RECONNECT_MS,
        idleTimeoutMs: env.OPS_BUILDER_ORACLE_IDLE_MS,
        livenessMs: env.OPS_BUILDER_ORACLE_LIVENESS_MS,
        livenessTimeoutMs: env.OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS,
        onReject: (r) => feed?.onReject(r),
        ...(d.webSocket ? { webSocket: d.webSocket } : {}),
      })
    : null;
  if (!domain) log.error({ baseUrl: env.ORDERLY_BASE_URL }, "live builder prices NOT pushed: no Builder Oracle WebSocket domain for this ORDERLY_BASE_URL (set ORDERLY_ORACLE_WS_URL)");
  const f = new BuilderPriceFeed({
    socket,
    notConfigured: "no Builder Oracle WebSocket domain (ORDERLY_ORACLE_WS_URL)",
    targets: () => builderFeedTargets(d.books()),
    log,
    intervalMs: env.OPS_BUILDER_PRICE_INTERVAL_MS,
    maxAgeMs: env.OPS_BUILDER_PRICE_MAX_AGE_MS,
  });
  feed = f;
  d.sub.on("message", (channel, message) => {
    if (channel === KEYS.oracleVenueFeed) f.onFeedJson(message);
  });
  await d.sub.subscribe(KEYS.oracleVenueFeed).catch((err: unknown) => log.warn({ err: String(err) }, "oracle venue feed subscribe failed (redis down?): the key is re-read every few seconds"));
  socket?.start();
  const done = f.run(d.signal, { refresh: async () => f.onFeedJson(await d.redis.get(KEYS.oracleVenueFeed)), publishStatus: d.publishStatus });
  log.info({ domain, accountId, key: key.orderlyKey.slice(0, 16), intervalMs: f.intervalMs, maxAgeMs: f.maxAgeMs }, "live builder price push started");
  return {
    feed: f,
    socket,
    done,
    stop: async () => {
      socket?.stop();
      await done;
    },
  };
}
