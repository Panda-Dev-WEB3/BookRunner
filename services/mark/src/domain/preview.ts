// Tranche NAV preview (pure): the NORMATIVE applyMarkPnl from shared waterfall.ts on the book's current
// on-chain S / J / impairment / perf index / high-water and the backstop balance.
import { type MarkResult, applyMarkPnl, drawdownKill, sharePriceWad } from "@bookrunner/shared";
import type { MarkSnapshot } from "./types";

export interface TranchePreview {
  result: MarkResult;
  seniorPrice: bigint;
  juniorPrice: bigint;
  killAtMark: boolean;
}

export function previewTranches(s: Pick<MarkSnapshot, "book" | "backstopBalance" | "mandate">, navUsd: bigint): TranchePreview {
  const result = applyMarkPnl(
    { seniorNav: s.book.seniorNav, juniorNav: s.book.juniorNav, seniorImpairment: s.book.seniorImpairment, perfIndex: s.book.perfIndex, highWater: s.book.highWater },
    { nav: navUsd, juniorSupply: s.book.juniorSupply, backstopAvailable: s.backstopBalance },
  );
  return {
    result,
    seniorPrice: sharePriceWad(result.seniorNav, s.book.seniorSupply),
    juniorPrice: sharePriceWad(result.juniorNav, s.book.juniorSupply),
    killAtMark: drawdownKill(result.drawdownBps, BigInt(s.mandate.killAtDrawdownBps)),
  };
}
