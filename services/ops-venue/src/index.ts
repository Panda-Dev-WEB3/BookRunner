// @bookrunner/ops-venue — library surface. The service entry is src/main.ts (`bun run start`).
//   import { OrderlyVenue, createOrderlyVenue } from "@bookrunner/ops-venue/client"   (agent, risk)
export {
  createOrderlyVenue,
  type FeeSettlement,
  OrderlyBuilderClient,
  type OrderlyBuilderClientOptions,
  type OrderlyMode,
  OrderlyQuoteError,
  OrderlyVenue,
  type OrderlyVenueOptions,
} from "./client";
export { type BookKeyFile, KeyStore, OPS_SCOPE, resolveKeysDir, TRADE_SCOPE } from "./keys";
import { KeyStore, resolveKeysDir } from "./keys";
export { base58Decode, base58Encode, type Ed25519Key, formatOrderlyKey, generateKey, keyFromSecret, keyPrefix, signatureMessage, signRequest } from "./orderly/auth";
export { orderlyAccountId, toVenueAccount, toVenueFill } from "./orderly/convert";
export { type FetchLike, OrderlyHttp, OrderlyHttpError } from "./orderly/http";
export { BUILDER_PATHS, ORDERLY_PATHS } from "./orderly/paths";

/** Load the book's active venue trade key from the ops-venue key store (null if none / revoked). */
export function loadBookTradeKey(bookId: number, keysDir?: string) {
  return new KeyStore(resolveKeysDir(keysDir)).tradeKey(bookId);
}
