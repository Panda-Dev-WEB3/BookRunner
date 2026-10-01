// Dependency container handed to routers (tRPC context), REST, MCP and webhook routes.
import type { Logger } from "@bookrunner/shared/logger";
import type { ChainGateway } from "./chain/gateway";
import type { ReadModel, WebhookStore } from "./data/types";
import type { CharterIssue, CharterDraftInput } from "./domain/charter";
import type { Kv } from "./kv";

export interface CharterServiceClient {
  /** Validation issues from services/charter, or null when it is unreachable / answers unexpectedly. */
  validate(draft: CharterDraftInput): Promise<CharterIssue[] | null>;
}

export interface ApiSettings {
  chainId: number;
  /** Fallback when the chain is unreachable (config.markInterval() is authoritative). */
  markIntervalSeconds: number;
  receiptsIntervalSeconds: number;
  maxPriceAgeSeconds: number;
  adminToken?: string;
}

export interface ApiDeps {
  settings: ApiSettings;
  log: Logger;
  data: ReadModel;
  webhooks: WebhookStore;
  kv: Kv;
  /** Current chain gateway, or null while the deployment file is missing. */
  chain: () => ChainGateway | null;
  charterService: CharterServiceClient | null;
  now: () => number; // unix ms
  /** Liveness of the runtime pieces, for /health. */
  health?: () => Promise<Record<string, unknown>>;
}
