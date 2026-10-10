// Stock Token price conventions + per-chain price configuration (config/chains/<chainId>.json).
//
// THE MULTIPLIER CONVENTION (VERIFY C2 / T2) — the multiplier is applied EXACTLY ONCE, in the registry:
//   - AttestedOracle prices are USD per 1 SHARE of the underlying equity (WAD), keyed by price id.
//   - A Robinhood Stock Token's ERC-8056 uiMultiplier() (WAD, 1e18 = 1.0) = shares per whole token.
//   - Robinhood's Chainlink feeds quote per TOKEN: feed = share price x uiMultiplier. The oracle service
//     converts them to per share with the same on-chain uiMultiplier: perShare = feed * 1e18 / uiMultiplier
//     (Robinhood's own "underlying share price" formula), before the median with per-share sources.
//   - StockTokenRegistry.valueUsd = qty x multiplier x perShare (multiplier = the token's live
//     uiMultiplier() on mainnet) = qty x feed. Every off-chain mirror (risk, agent, charter) reads the
//     effective multiplier from registry.getToken and applies it once; mark reads registry.valueUsd(At).
// MULTIPLIER_VECTOR pins one worked example; the same numbers are asserted in Solidity
// (contracts/test/mandate/StockTokenRegistryLiveMultiplier.t.sol) and by each service's mirror.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import { REPO_ROOT } from "./deployments";
import { WAD } from "./units";

/** Robinhood Chain mainnet (testnet: TESTNET_CHAIN_ID 46630 in devkeys.ts): synthetic prices are impossible here; the oracle enforces production rules. */
export const MAINNET_CHAIN_ID = 4663;

export const isMainnet = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;

/**
 * Worked example of the convention (NVDA uiMultiplier from api.robinhood.com/rhj/assets on 2026-10-10).
 * perSharePriceWad = round8(feed / uiMultiplier) — what the oracle signs (8 dp, PRICE_DECIMALS);
 * valueUsd6 = floor(qty x uiMultiplier x perShare) = floor(qty x feed) in USD 6 dp;
 * doubleAppliedUsd6 = what a per-token price valued with the multiplier again would give.
 */
export const MULTIPLIER_VECTOR = {
  qtyRaw: 12_500_000_000_000_000_000n, // 12.5 tokens, 18 decimals
  decimals: 18,
  uiMultiplierWad: 1_000_775_159_164_630_595n,
  feedAnswer: 18_512_345_678n, // $185.12345678 per TOKEN
  feedDecimals: 8,
  perSharePriceWad: 184_980_067_790_000_000_000n,
  perSharePrice: 184.98006779,
  valueUsd6: 2_314_043_209n,
  doubleAppliedUsd6: 2_315_836_961n,
} as const;

/** Chainlink answer scaled to WAD (USD per token or per share, as the feed quotes). */
export function feedAnswerToWad(answer: bigint, decimals: number): bigint {
  if (decimals < 0 || decimals > 36) throw new Error(`feed decimals ${decimals} out of range`);
  return decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
}

/** Per-share price (WAD) from a per-token price (WAD) and the token's uiMultiplier (WAD). Floors. */
export function perSharePriceWad(tokenPriceWad: bigint, uiMultiplierWad: bigint): bigint {
  if (uiMultiplierWad <= 0n) throw new Error("uiMultiplier must be > 0");
  return (tokenPriceWad * WAD) / uiMultiplierWad;
}

// ------------------------------------------------------------------ per-chain price configuration

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");

export const stockTokenConfigSchema = z.object({
  token: address,
  /** Oracle price id label (bytes32 right-padded ASCII); defaults to the map key. */
  priceId: z.string().min(1).max(31).optional(),
  decimals: z.number().int().min(0).max(30).default(18),
  /** "uiMultiplier" = registry live mode (StockTokenRegistry.setMultiplierSource(token, true)). */
  multiplierSource: z.enum(["uiMultiplier", "stored"]).default("uiMultiplier"),
});

export const feedConfigSchema = z.object({
  /** Feed proxy (EACAggregatorProxy) — never the underlying aggregator. */
  proxy: address,
  /**
   * per-token: the answer includes the Stock Token multiplier (Robinhood tokenized-equity feeds) and is
   * divided by the token's uiMultiplier(); per-share: a plain equity feed, used as is.
   */
  basis: z.enum(["per-token", "per-share"]),
  /** Stock Token whose uiMultiplier()/oraclePaused() apply (per-token); default: stockTokens[id].token. */
  token: address.optional(),
  /** Expected decimals (checked against decimals() read on-chain; a mismatch refuses the feed). */
  decimals: z.number().int().min(0).max(36).optional(),
  /** Chainlink heartbeat (s). In-session staleness bound = heartbeat + the oracle's grace. */
  heartbeatSec: z.number().int().positive().optional(),
  /** Explicit in-session max age (s); overrides heartbeat + grace. */
  maxAgeSec: z.number().int().positive().optional(),
  deviationBps: z.number().nonnegative().optional(),
  /** Expected description() substring (source-check warns when it differs). */
  description: z.string().optional(),
  marketHours: z.string().optional(),
});

export const chainPriceConfigSchema = z
  .object({
    chainId: z.number().int().positive(),
    name: z.string().optional(),
    researchedAt: z.string().optional(),
    sources: z.record(z.string(), z.string()).optional(),
    note: z.string().optional(),
    stockTokens: z.record(z.string(), stockTokenConfigSchema).default({}),
    chainlink: z
      .object({
        /** Chainlink L2 sequencer uptime feed (answer 0 = up); null = not available / not checked. */
        sequencerUptimeFeed: address.nullable().default(null),
        feeds: z.record(z.string(), feedConfigSchema).default({}),
      })
      .default({ sequencerUptimeFeed: null, feeds: {} }),
  })
  .superRefine((c, ctx) => {
    for (const [id, f] of Object.entries(c.chainlink.feeds)) {
      if (f.basis === "per-token" && !f.token && !c.stockTokens[id]) {
        ctx.addIssue({ code: "custom", path: ["chainlink", "feeds", id], message: "per-token feed needs `token` or a stockTokens entry (its uiMultiplier converts the feed to per share)" });
      }
    }
  });

export type ChainPriceConfig = z.infer<typeof chainPriceConfigSchema>;
export type FeedConfig = z.infer<typeof feedConfigSchema>;
export type StockTokenConfig = z.infer<typeof stockTokenConfigSchema>;

/** Default location of a chain's price config: <repo>/config/chains/<chainId>.json. */
export function chainPriceConfigPath(chainId: number, file?: string): string {
  if (file) return isAbsolute(file) ? file : resolve(REPO_ROOT, file);
  return resolve(REPO_ROOT, "config", "chains", `${chainId}.json`);
}

export function parseChainPriceConfig(raw: unknown, origin = "chain price config"): ChainPriceConfig {
  const parsed = chainPriceConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${origin}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * Loads config/chains/<chainId>.json (or `file`). Returns null when the default file does not exist; an
 * explicit `file` that is missing, or a file for another chain, throws.
 */
export function loadChainPriceConfig(chainId: number, file?: string): ChainPriceConfig | null {
  const p = chainPriceConfigPath(chainId, file);
  if (!existsSync(p)) {
    if (file) throw new Error(`chain price config not found: ${p}`);
    return null;
  }
  const cfg = parseChainPriceConfig(JSON.parse(readFileSync(p, "utf8")), p);
  if (cfg.chainId !== chainId) throw new Error(`${p}: chainId ${cfg.chainId} != ${chainId}`);
  return cfg;
}

/** Stock Token address governing a feed (explicit `token`, else the stockTokens entry of the same id). */
export function feedToken(cfg: Pick<ChainPriceConfig, "stockTokens">, id: string, f: Pick<FeedConfig, "token">): Address | null {
  const t = f.token ?? cfg.stockTokens[id]?.token;
  return t ? getAddress(t) : null;
}
