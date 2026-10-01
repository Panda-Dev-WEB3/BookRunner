// POST /charters/draft: parse (human units) -> validate (TS mirror of MarketCharter.validate, with an
// eth_call cross-check when the chain is reachable) -> encoded struct + prepared transactions.
import { type Charter, type Logger, checkCopy } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";
import { type CharterJson, charterToJson } from "../domain/charterJson";
import { type TickerBook, parseCharterDraft } from "../domain/draft";
import { type PreparedTx, encodeCharter, prepareFilingTxs } from "../domain/prepare";
import {
  DEFAULT_VENUE_MIN_IF_USD,
  type ReasonCode,
  type ValidationContext,
  type ValidationResult,
  reasonToBytes32,
  validateCharter,
} from "../domain/validate";
import type { CharterChain } from "../adapters/chain";

export interface DraftResponse {
  ok: boolean;
  reason: ReasonCode | null;
  reasonBytes32: Hex;
  reasons: ReasonCode[];
  details: ValidationResult["details"];
  chainChecked: boolean;
  onChain: { reason: ReasonCode | null; matches: boolean } | null;
  charter: CharterJson;
  encoded: Hex;
  hedgeAllow: Array<{ asset: Hex; venue: Hex }> | null;
  transactions: PreparedTx[];
  warnings: string[];
}

/** Offline context: ARCHITECTURE defaults for venue minimums; underlying accepted but flagged. */
const offlineContext: ValidationContext = {
  venueMinIfUsd: (v) => DEFAULT_VENUE_MIN_IF_USD[v] ?? 0n,
  isCanonicalToken: () => true,
  isIndex: () => true,
};

export async function handleDraft(
  body: unknown,
  deps: { chain: CharterChain | null; chainId: number; tickers: TickerBook; logger: Logger },
): Promise<DraftResponse> {
  const d = parseCharterDraft(body, deps.tickers);
  const c: Charter = d.charter;
  const warnings = [...d.warnings];

  let ctx: ValidationContext = offlineContext;
  let chainChecked = false;
  if (deps.chain) {
    try {
      ctx = await deps.chain.validationContextFor(c);
      chainChecked = true;
    } catch (err) {
      deps.logger.warn({ err }, "draft: chain unreachable, validating with defaults");
    }
  }
  if (!chainChecked) warnings.push("chain unavailable: venue minimums use protocol defaults and the underlying is not verified");

  const v = validateCharter(c, ctx);

  let onChain: DraftResponse["onChain"] = null;
  if (deps.chain && chainChecked) {
    try {
      const r = await deps.chain.validateOnChain(c);
      onChain = { reason: r.reason, matches: r.reason === v.reason };
      if (!onChain.matches) {
        deps.logger.warn({ ts: v.reason, onChain: r.reason }, "draft: TS validation differs from MarketCharter.validate");
        warnings.push(`on-chain validate() returned ${r.reason ?? "ok"}; the contract is authoritative`);
      }
    } catch (err) {
      deps.logger.debug({ err }, "draft: validate() eth_call failed");
    }
  }
  const effectiveOk = onChain ? onChain.reason === null : v.ok;

  let transactions: PreparedTx[] = [];
  if (effectiveOk && deps.chain && chainChecked) {
    try {
      const state = await deps.chain.sponsorState(c.sponsor);
      const c0 = deps.chain.deployment.contracts;
      const prepared = prepareFilingTxs(c, state, { bkrn: c0.bkrn, staking: c0.staking, usdc: c0.usdc, charter: c0.charter }, deps.chainId);
      transactions = prepared.transactions;
      warnings.push(...prepared.warnings);
    } catch (err) {
      deps.logger.warn({ err }, "draft: could not read sponsor state");
      warnings.push("could not read sponsor balances/allowances; transactions not prepared");
    }
  } else if (effectiveOk && !chainChecked) {
    warnings.push("transactions are prepared only when the deployment is available");
  }

  const metaText = [d.meta?.name, d.meta?.description].filter(Boolean).join("\n");
  for (const viol of checkCopy(metaText)) warnings.push(`copy rules: "${viol.term}" in charter metadata — use "${viol.use}"`);

  const reason = onChain ? onChain.reason : v.reason;
  return {
    ok: effectiveOk,
    reason,
    reasonBytes32: reason ? reasonToBytes32(reason) : zeroHash,
    reasons: v.reasons,
    details: v.details,
    chainChecked,
    onChain,
    charter: charterToJson(c),
    encoded: encodeCharter(c),
    hedgeAllow: d.hedgeAllow,
    transactions,
    warnings,
  };
}
