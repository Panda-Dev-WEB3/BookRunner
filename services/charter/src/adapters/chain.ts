// Chain adapter for the charter service: reads for validation / rule checks / prepared txs, and the
// writes this service makes with the JURY role account: RiskCommittee.postJuryVerdict, then the
// permissionless RiskCommittee.tryFinalize (postJuryVerdict never finalizes by itself, so approvals
// cast before the verdict would otherwise wait for a further vote that may never come).
import {
  CHARTER_STATUS,
  type Charter,
  type CharterStatus,
  type Deployment,
  type Logger,
  isTokenUnderlying,
  publicClientFor,
  roleSigner,
  underlyingToToken,
  walletClientFor,
} from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bkrnStakingAbi,
  bookrunnerConfigAbi,
  marketCharterAbi,
  riskCommitteeAbi,
  stockTokenRegistryAbi,
} from "@bookrunner/shared/abi";
import { type Address, type Hex, type PublicClient, erc20Abi, zeroAddress } from "viem";
import { charterFromJson } from "../domain/charterJson";
import { type SponsorState, charterArg } from "../domain/prepare";
import type { PriceFacts, RuleContext, StockTokenFacts, UnderlyingFacts } from "../domain/ruleChecks";
import { type ReasonCode, type ValidationContext, reasonFromBytes32, staticValidationContext, validateCharter } from "../domain/validate";

/** Gas limit from an eth_estimateGas result: +30% + 30k (state can move between estimate and mining). */
export const bufferedGas = (estimate: bigint): bigint => (estimate * 13n) / 10n + 30_000n;

export interface CharterRecordView {
  charterId: number;
  charter: Charter;
  status: CharterStatus;
  filedAt: number;
  decidedAt: number;
  juryDigest: Hex;
  book: Address;
}

export interface LiquidityConfig {
  /** keys: ticker, token address or underlying (lowercase hex); values: USD (human units) */
  depthUsd: Record<string, string>;
}

export class CharterChain {
  readonly pub: PublicClient;
  private readonly env: Record<string, string | undefined>;

  constructor(
    readonly deployment: Deployment,
    private readonly opts: { chainId: number; rpcUrl: string; env?: Record<string, string | undefined>; logger: Logger; liquidity?: LiquidityConfig },
  ) {
    this.pub = publicClientFor(opts.chainId, opts.rpcUrl);
    this.env = opts.env ?? process.env;
  }

  get c() {
    return this.deployment.contracts;
  }

  // ------------------------------------------------------------ validation inputs

  async validationContextFor(ch: Charter): Promise<ValidationContext> {
    const venueMin = await this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "venueMinIfUsd", args: [ch.venue] });
    let canonical: string[] = [];
    let indexes: string[] = [];
    if (isTokenUnderlying(ch.underlying)) {
      const token = underlyingToToken(ch.underlying);
      if (token !== zeroAddress) {
        const ok = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "isCanonical", args: [token] });
        if (ok) canonical = [token];
      }
    } else {
      const ok = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "isIndex", args: [ch.underlying] });
      if (ok) indexes = [ch.underlying];
    }
    return staticValidationContext({ venueMinIfUsd: { [ch.venue]: venueMin }, canonicalTokens: canonical, indexIds: indexes });
  }

  /** eth_call MarketCharter.validate(c) — parity cross-check with the TS mirror. */
  async validateOnChain(ch: Charter): Promise<{ reason: ReasonCode | null; raw: Hex }> {
    const raw = await this.pub.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "validate", args: [charterArg(ch)] });
    return { reason: reasonFromBytes32(raw), raw };
  }

  async sponsorState(sponsor: Address): Promise<SponsorState> {
    const c = this.c;
    const [sponsorBondBkrn, charterFeeUsd, newBooksPaused, stakingAvailable, bkrnBalance, bkrnAllowanceToStaking, usdcBalance, usdcAllowanceToCharter] = await Promise.all([
      this.pub.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "sponsorBondBkrn" }),
      this.pub.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "charterFeeUsd" }),
      this.pub.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "newBooksPaused" }),
      this.pub.readContract({ address: c.staking, abi: bkrnStakingAbi, functionName: "availableOf", args: [sponsor] }),
      this.pub.readContract({ address: c.bkrn, abi: erc20Abi, functionName: "balanceOf", args: [sponsor] }),
      this.pub.readContract({ address: c.bkrn, abi: erc20Abi, functionName: "allowance", args: [sponsor, c.staking] }),
      this.pub.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [sponsor] }),
      this.pub.readContract({ address: c.usdc, abi: erc20Abi, functionName: "allowance", args: [sponsor, c.charter] }),
    ]);
    return { sponsorBondBkrn, charterFeeUsd, newBooksPaused, stakingAvailable, bkrnBalance, bkrnAllowanceToStaking, usdcBalance, usdcAllowanceToCharter };
  }

  // ------------------------------------------------------------ charters / committee

  async charterCount(): Promise<number> {
    return Number(await this.pub.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "count" }));
  }

  async charterRecord(id: number): Promise<CharterRecordView | null> {
    const r = await this.pub.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "get", args: [BigInt(id)] });
    const status = CHARTER_STATUS[r.status] ?? "None";
    if (status === "None") return null;
    return {
      charterId: id,
      charter: charterFromJson(r.charter),
      status,
      filedAt: Number(r.filedAt),
      decidedAt: Number(r.decidedAt),
      juryDigest: r.juryCid,
      book: r.book,
    };
  }

  async juryVerdict(id: number): Promise<{ posted: boolean; digest: Hex; recommendApprove: boolean }> {
    const [digest, recommendApprove, posted] = await this.pub.readContract({ address: this.c.committee, abi: riskCommitteeAbi, functionName: "juryVerdict", args: [BigInt(id)] });
    return { posted, digest, recommendApprove };
  }

  async committee(): Promise<{ members: Address[]; bonded: boolean[]; committeeBondBkrn: bigint; committeeWindowSec: number }> {
    const [members, committeeBondBkrn, window] = await Promise.all([
      this.pub.readContract({ address: this.c.committee, abi: riskCommitteeAbi, functionName: "members" }),
      this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "committeeBondBkrn" }),
      this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "committeeWindow" }),
    ]);
    const seated = [...members];
    const bonded = await Promise.all(
      seated.map((m) => (m === zeroAddress ? Promise.resolve(false) : this.pub.readContract({ address: this.c.committee, abi: riskCommitteeAbi, functionName: "isBonded", args: [m] }))),
    );
    return { members: seated, bonded, committeeBondBkrn, committeeWindowSec: Number(window) };
  }

  /** JURY role write; waits for the receipt and throws on revert. */
  async postJuryVerdict(charterId: number, digest: Hex, recommendApprove: boolean): Promise<Hex> {
    const account = await roleSigner("jury", this.env); // local key or KMS (cached per process)
    const wallet = walletClientFor(this.opts.chainId, this.opts.rpcUrl, account);
    const call = {
      account,
      address: this.c.committee,
      abi: riskCommitteeAbi,
      functionName: "postJuryVerdict",
      args: [BigInt(charterId), digest, recommendApprove],
    } as const;
    const { request } = await this.pub.simulateContract(call);
    const hash = await wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    this.opts.logger.info({ charterId, digest, recommendApprove, tx: hash }, "postJuryVerdict sent");
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`postJuryVerdict reverted (tx ${hash})`);
    this.opts.logger.info({ charterId, tx: hash, block: Number(receipt.blockNumber) }, "postJuryVerdict confirmed");
    return hash;
  }

  /**
   * RiskCommittee.tryFinalize(charterId): permissionless, returns false without reverting when the
   * thresholds are not met. Simulated first; a tx is only sent when it would decide the charter.
   */
  async tryFinalize(charterId: number): Promise<{ finalized: boolean; tx: Hex | null }> {
    const account = await roleSigner("jury", this.env);
    const call = { account, address: this.c.committee, abi: riskCommitteeAbi, functionName: "tryFinalize", args: [BigInt(charterId)] } as const;
    const { request, result } = await this.pub.simulateContract(call);
    if (!result) return { finalized: false, tx: null };
    const wallet = walletClientFor(this.opts.chainId, this.opts.rpcUrl, account);
    // MarketCharter.decide -> BookFactory.create deploys the whole book: the buffer matters here
    const hash = await wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tryFinalize reverted (tx ${hash})`);
    this.opts.logger.info({ charterId, tx: hash, block: Number(receipt.blockNumber) }, "committee decision finalized (tryFinalize)");
    return { finalized: true, tx: hash };
  }

  // ------------------------------------------------------------ rule-check context

  private async tokenFacts(token: Address): Promise<StockTokenFacts> {
    const t = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] });
    const price = await this.price(t.priceId);
    const ticker = Object.entries(this.deployment.stockTokens).find(([, v]) => v.token.toLowerCase() === token.toLowerCase())?.[0];
    const facts: StockTokenFacts = {
      token,
      priceId: t.priceId,
      multiplierWad: t.multiplierWad,
      decimals: t.decimals,
      active: t.active,
      floatCapRaw: t.floatCapRaw,
      priceWad: price.priceWad,
    };
    if (ticker) facts.ticker = ticker;
    return facts;
  }

  private async price(priceId: Hex): Promise<PriceFacts> {
    try {
      const p = await this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId] });
      if (p.priceWad === 0n) return { priceWad: null, publishedAt: null, held: false };
      return { priceWad: p.priceWad, publishedAt: Number(p.publishedAt), held: p.held };
    } catch {
      return { priceWad: null, publishedAt: null, held: false };
    }
  }

  private async underlyingFacts(u: Hex): Promise<UnderlyingFacts> {
    if (isTokenUnderlying(u)) {
      const token = underlyingToToken(u);
      if (token === zeroAddress) return { kind: "unknown" };
      const canonical = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "isCanonical", args: [token] });
      return canonical ? { kind: "token", token: await this.tokenFacts(token) } : { kind: "unknown" };
    }
    const isIndex = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "isIndex", args: [u] });
    if (!isIndex) return { kind: "unknown" };
    const [, components] = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getIndex", args: [u] });
    const out = [];
    for (const comp of components) out.push({ weightBps: Number(comp.weightBps), token: await this.tokenFacts(comp.token) });
    return { kind: "index", components: out };
  }

  private liquidityFor(u: Hex, facts: UnderlyingFacts): RuleContext["liquidity"] {
    const depth = this.opts.liquidity?.depthUsd ?? {};
    const keys = [u.toLowerCase()];
    if (facts.kind === "token") keys.unshift(facts.token.ticker ?? "", facts.token.token.toLowerCase());
    for (const k of keys) {
      const v = k ? (depth[k] ?? depth[k.toUpperCase()]) : undefined;
      if (v !== undefined && /^\d+(\.\d+)?$/.test(v)) {
        const [i = "0", f = ""] = v.split(".");
        return { mode: "configured", usd: BigInt(i) * 10n ** 6n + BigInt((f + "000000").slice(0, 6)) };
      }
    }
    // devnet and testnet books hedge in the protocol's own mock Stock Tokens via the mock router
    return this.opts.chainId === 31337 || this.opts.chainId === 46630 ? { mode: "devnet_mock", usd: null } : { mode: "unknown", usd: null };
  }

  async ruleContext(ch: Charter, nowSec = Math.floor(Date.now() / 1000)): Promise<RuleContext> {
    const [venueMinIfUsd, maxPriceAge, newBooksPaused, vctx, underlying, priceId] = await Promise.all([
      this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "venueMinIfUsd", args: [ch.venue] }),
      this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" }),
      this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "newBooksPaused" }),
      this.validationContextFor(ch),
      this.underlyingFacts(ch.underlying),
      this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "priceIdOf", args: [ch.underlying] }).catch(() => null),
    ]);
    const price: PriceFacts = priceId ? await this.price(priceId) : { priceWad: null, publishedAt: null, held: false };
    return {
      venueMinIfUsd,
      validation: validateCharter(ch, vctx),
      underlying,
      price,
      maxPriceAgeSec: Number(maxPriceAge),
      liquidity: this.liquidityFor(ch.underlying, underlying),
      newBooksPaused,
      nowSec,
    };
  }
}

export function parseLiquidityJson(raw: string | undefined, logger: Logger): LiquidityConfig | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const depthUsd: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) depthUsd[k.startsWith("0x") ? k.toLowerCase() : k] = String(v);
    return { depthUsd };
  } catch (err) {
    logger.warn({ err }, "JURY_LIQUIDITY_JSON is not valid JSON; ignoring");
    return undefined;
  }
}
