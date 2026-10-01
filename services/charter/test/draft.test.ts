// Draft parsing (human units) + prepared filing transactions.
import { describe, expect, test } from "bun:test";
import { HEDGE_VENUES, SESSIONS_24X5, bytes32ToStr, encodeSessions, hedgeAllowTree, tokenUnderlying, usd } from "@bookrunner/shared";
import { bkrnStakingAbi, marketCharterAbi } from "@bookrunner/shared/abi";
import { type Address, decodeAbiParameters, decodeFunctionData, erc20Abi, getAddress, zeroHash } from "viem";
import { charterFromJson, charterToJson } from "../src/domain/charterJson";
import { DraftError, parseCharterDraft, parseDuration } from "../src/domain/draft";
import { type SponsorState, encodeCharter, prepareFilingTxs } from "../src/domain/prepare";
import { NVDA_TOKEN, SPONSOR, nvdaCharter } from "./fixtures";

const draft = (over: Record<string, unknown> = {}) => ({
  sponsor: SPONSOR,
  underlying: { ticker: "NVDA" },
  venue: "orderly",
  oracle: "attested",
  sessions: "24x5",
  ifTargetUsd: "25000",
  mmInventoryUsd: "75,000",
  mandate: {
    maxInventoryUsd: "50000",
    maxSkewBps: 25,
    minQuoteWidthBps: 8,
    hedgeRatioMinBps: 5000,
    hedgeRatioMaxBps: 12000,
    killAtDrawdownBps: -800,
    hedgeAllow: [{ asset: { ticker: "NVDA" }, venue: "UNIV3" }],
  },
  seniorHurdleBps: 6000,
  seniorCapBps: 7000,
  subscriptionWindow: "10m",
  juniorNoticeSeconds: "15m",
  perWalletCapUsd: "250000",
  symbol: "PERP_NVDA_USDC",
  ...over,
});
const TICKERS = { NVDA: { token: NVDA_TOKEN } };

describe("parseCharterDraft", () => {
  test("human units map to the exact BRTypes.Charter of the launch book", () => {
    const r = parseCharterDraft(draft(), TICKERS);
    expect(r.charter).toEqual(nvdaCharter());
    expect(r.hedgeAllow).toEqual([{ asset: tokenUnderlying(NVDA_TOKEN), venue: HEDGE_VENUES.UNIV3 }]);
    expect(r.charter.mandate.hedgeAllowRoot).toBe(hedgeAllowTree(r.hedgeAllow!).root.toLowerCase() as `0x${string}`);
    expect(r.charter.sessions).toBe(encodeSessions(SESSIONS_24X5));
    expect(bytes32ToStr(r.charter.symbol)).toBe("PERP_NVDA_USDC");
  });

  test("defaults: oracle attested, sessions 24x5, notice 7d, leverage 1x, off-hours reduce-only", () => {
    const d = draft();
    delete (d as Record<string, unknown>).oracle;
    delete (d as Record<string, unknown>).sessions;
    delete (d as Record<string, unknown>).juniorNoticeSeconds;
    const r = parseCharterDraft(d, TICKERS);
    expect(r.charter.oracle).toBe(1);
    expect(r.charter.sessions).toBe(encodeSessions(SESSIONS_24X5));
    expect(r.charter.juniorNoticeSeconds).toBe(7n * 86_400n);
    expect(r.charter.mandate.maxHedgeLeverage).toBe(100);
    expect(r.charter.mandate.noNewRiskOffHours).toBe(true);
  });

  test("protocol-rule violations are NOT schema errors (left to validateCharter)", () => {
    const r = parseCharterDraft(draft({ seniorCapBps: 10_001, venue: 7, symbol: "" }), TICKERS);
    expect(r.charter.seniorCapBps).toBe(10_001);
    expect(r.charter.venue as number).toBe(7);
    expect(r.charter.symbol).toBe(zeroHash);
  });

  test("type-range and format errors are reported with paths", () => {
    try {
      parseCharterDraft(draft({ ifTargetUsd: "25000.1234567", seniorHurdleBps: 70_000, sponsor: "0x123" }), TICKERS);
      throw new Error("expected DraftError");
    } catch (e) {
      expect(e).toBeInstanceOf(DraftError);
      const paths = (e as DraftError).issues.map((i) => i.path).sort();
      expect(paths).toEqual(["ifTargetUsd", "seniorHurdleBps", "sponsor"]);
    }
    expect(() => parseCharterDraft(draft({ underlying: { ticker: "XYZ" } }), TICKERS)).toThrow(DraftError);
  });

  test("durations", () => {
    expect(parseDuration("10m")).toBe(600n);
    expect(parseDuration("7d")).toBe(604_800n);
    expect(parseDuration(90)).toBe(90n);
    expect(parseDuration("1.5h")).toBeNull();
  });

  test("struct_json round trip", () => {
    const c = nvdaCharter();
    expect(charterFromJson(JSON.parse(JSON.stringify(charterToJson(c))))).toEqual(c);
  });

  test("encoded struct decodes back to the charter", () => {
    const c = nvdaCharter();
    const fileFn = marketCharterAbi.find((x) => x.type === "function" && x.name === "file");
    if (!fileFn || fileFn.type !== "function") throw new Error("no file()");
    const [decoded] = decodeAbiParameters(fileFn.inputs, encodeCharter(c));
    expect(charterFromJson(decoded)).toEqual(c);
  });
});

describe("prepareFilingTxs", () => {
  const ADDRS = {
    bkrn: "0x0000000000000000000000000000000000000b01" as Address,
    staking: "0x0000000000000000000000000000000000000b02" as Address,
    usdc: "0x0000000000000000000000000000000000000b03" as Address,
    charter: "0x0000000000000000000000000000000000000b04" as Address,
  };
  const BOND = 100_000n * 10n ** 18n;
  const state = (over: Partial<SponsorState> = {}): SponsorState => ({
    sponsorBondBkrn: BOND,
    charterFeeUsd: usd("5000"),
    stakingAvailable: 0n,
    bkrnBalance: BOND * 2n,
    bkrnAllowanceToStaking: 0n,
    usdcBalance: usd("10000"),
    usdcAllowanceToCharter: 0n,
    newBooksPaused: false,
    ...over,
  });

  test("fresh sponsor: approve BKRN, stake, approve USDC fee, file", () => {
    const c = nvdaCharter();
    const { transactions, warnings } = prepareFilingTxs(c, state({ stakingAvailable: 40_000n * 10n ** 18n }), ADDRS, 31337);
    expect(transactions.map((t) => t.kind)).toEqual(["approve_bkrn", "stake_bkrn", "approve_usdc", "file"]);
    expect(warnings).toEqual([]);
    const shortfall = 60_000n * 10n ** 18n;
    expect(decodeFunctionData({ abi: erc20Abi, data: transactions[0]!.data }).args).toEqual([getAddress(ADDRS.staking), shortfall]);
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: transactions[1]!.data }).args).toEqual([shortfall]);
    expect(decodeFunctionData({ abi: erc20Abi, data: transactions[2]!.data }).args).toEqual([getAddress(ADDRS.charter), usd("5000")]);
    const file = decodeFunctionData({ abi: marketCharterAbi, data: transactions[3]!.data });
    expect(file.functionName).toBe("file");
    expect(charterFromJson(file.args?.[0])).toEqual(c);
    for (const t of transactions) {
      expect(t.from).toBe(SPONSOR);
      expect(t.chainId).toBe(31337);
      expect(t.value).toBe("0");
    }
    expect(transactions[3]!.to).toBe(ADDRS.charter);
  });

  test("already staked and approved: only file()", () => {
    const { transactions } = prepareFilingTxs(nvdaCharter(), state({ stakingAvailable: BOND, usdcAllowanceToCharter: usd("5000") }), ADDRS, 31337);
    expect(transactions.map((t) => t.kind)).toEqual(["file"]);
  });

  test("warnings for short balances and paused books", () => {
    const { warnings, transactions } = prepareFilingTxs(nvdaCharter(), state({ bkrnBalance: 0n, usdcBalance: 0n, newBooksPaused: true, bkrnAllowanceToStaking: BOND }), ADDRS, 31337);
    expect(transactions.map((t) => t.kind)).toEqual(["stake_bkrn", "approve_usdc", "file"]);
    expect(warnings).toHaveLength(3);
  });
});
