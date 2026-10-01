// MarkPnl statement (pure). keccak256(canonicalJson(pnl)) == MarkInput.pnlJsonHash.
// Number formats (canonical): USD amounts fixed 6-dp decimal strings, tranche prices fixed 18-dp
// decimal strings, raw quantities / WAD values as integer strings, utilisations rounded to 6 dp.
//
// pnl section (all for the period ending at periodEnd, USD):
//   markPnlUsd    = navUsd - (seniorNav + juniorNav) before the mark (applyMarkPnl.pnl)
//   feeFlowUsd    = senior + junior credited by this period's distribution (already in S + J)
//   fundingUsd    = funding settlements booked in the period (settlements.source = 'funding')
//   unrealizedUsd = open-position mark-to-market embedded in NAV at periodEnd (level):
//                   in-house engine: poolEquity - poolCash; Orderly: 0 (the venue report carries
//                   equity only — VERIFY whether the builder API exposes unsettled PnL per account)
//   realizedUsd   = markPnlUsd - fundingUsd - (unrealizedUsd - previous mark's unrealizedUsd)
import { BPS, type Mandate, type MarkPnl, absBig, canonicalJson, inventoryUtil } from "@bookrunner/shared";
import { usd6, wad18 } from "@bookrunner/waterfall";
import { type Hex, getAddress, keccak256, stringToHex } from "viem";
import type { NavComposition } from "./nav";
import type { TranchePreview } from "./preview";
import type { MarkSnapshot } from "./types";

export interface PnlExtras {
  feeFlowUsd: bigint;
  fundingUsd: bigint;
  prevUnrealizedUsd: bigint;
  /** Last quote skew at or before periodEnd (bps), null if none. */
  lastQuoteSkewBps: number | null;
}

const round6 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0);

export function unrealizedUsd(s: Pick<MarkSnapshot, "venue">): bigint {
  if (s.venue.poolEquityUsd === null || s.venue.poolCashUsd === null) return 0n;
  return s.venue.poolEquityUsd - s.venue.poolCashUsd;
}

/** |offsetting desk hedge| / |venue exposure| in bps, without the enforcement threshold (0 if flat). */
export function rawHedgeRatioBps(netExposureUsd: bigint, deskHedgeUsd: bigint): number {
  if (netExposureUsd === 0n) return 0;
  const offset = netExposureUsd > 0n ? -deskHedgeUsd : deskHedgeUsd;
  return Number(((offset > 0n ? offset : 0n) * BPS) / absBig(netExposureUsd));
}

export function limitsSection(mandate: Mandate, netExposureUsd: bigint, deskHedgeUsd: bigint, drawdownBps: bigint, lastQuoteSkewBps: number | null): MarkPnl["limits"] {
  return {
    inventoryUtil: round6(inventoryUtil(mandate, netExposureUsd)),
    skewUtil: lastQuoteSkewBps === null || mandate.maxSkewBps <= 0 ? 0 : round6(Math.abs(lastQuoteSkewBps) / mandate.maxSkewBps),
    hedgeRatioBps: rawHedgeRatioBps(netExposureUsd, deskHedgeUsd),
    drawdownBps: Number(drawdownBps),
  };
}

export function buildMarkPnl(args: { snapshot: MarkSnapshot; periodEnd: number; nav: NavComposition; preview: TranchePreview; extras: PnlExtras }): MarkPnl {
  const { snapshot: s, nav, preview, extras } = args;
  const markPnl = preview.result.pnl;
  const unrealized = unrealizedUsd(s);
  const realized = markPnl - extras.fundingUsd - (unrealized - extras.prevUnrealizedUsd);
  const hedgeNotional = s.desk.hedgeNotionalUsd ?? nav.deskHedgeValueUsd;
  return {
    bookId: String(s.bookId),
    periodEnd: args.periodEnd,
    navUsd: usd6(nav.navUsd),
    deployedValueUsd: usd6(nav.deployedValueUsd),
    vaultIdleUsd: usd6(s.vaultIdle),
    venue: {
      insuranceUsd: usd6(s.venue.insuranceUsd),
      marginUsd: usd6(s.venue.marginUsd),
      netExposureUsd: usd6(s.venue.netExposureUsd),
      inTransitUsd: usd6(s.venue.inTransitUsd),
      valuationAt: s.venue.valuationAt,
    },
    desk: {
      usdc: usd6(s.desk.usdc),
      hedgeValueUsd: usd6(nav.deskHedgeValueUsd),
      positions: s.desk.positions
        .filter((p) => p.qtyRaw > 0n)
        .map((p) => ({
          token: getAddress(p.token),
          qtyRaw: p.qtyRaw.toString(),
          priceWad: p.priceWad.toString(),
          multiplierWad: p.multiplierWad.toString(),
          valueUsd: usd6(p.valueUsd),
        }))
        .sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : a.token.toLowerCase() > b.token.toLowerCase() ? 1 : 0)),
    },
    pnl: {
      realizedUsd: usd6(realized),
      unrealizedUsd: usd6(unrealized),
      feeFlowUsd: usd6(extras.feeFlowUsd),
      fundingUsd: usd6(extras.fundingUsd),
      markPnlUsd: usd6(markPnl),
    },
    tranches: {
      seniorNav: usd6(preview.result.seniorNav),
      juniorNav: usd6(preview.result.juniorNav),
      seniorPrice: wad18(preview.seniorPrice),
      juniorPrice: wad18(preview.juniorPrice),
    },
    limits: limitsSection(s.mandate, s.venue.netExposureUsd, hedgeNotional, preview.result.drawdownBps, extras.lastQuoteSkewBps),
  };
}

/** pnlJsonHash = keccak256(utf8(canonicalJson(pnl))) — same as shared payloadHash. */
export function pnlJsonHash(pnl: MarkPnl): Hex {
  return keccak256(stringToHex(canonicalJson(pnl)));
}

/** Parses a fixed 6-dp USD string from a stored MarkPnl back to raw (0 on malformed input). */
export function parseUsd6(v: unknown): bigint {
  if (typeof v !== "string" || !/^-?\d+(\.\d{1,6})?$/.test(v)) return 0n;
  const neg = v.startsWith("-");
  const [i = "0", f = ""] = (neg ? v.slice(1) : v).split(".");
  const raw = BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  return neg ? -raw : raw;
}
