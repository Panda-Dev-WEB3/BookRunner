// viem / Postgres / Redis adapters of the liquidation keeper (liquidationKeeper.ts). RPC budget: one pass is ONE
// aggregate3 eth_call on mainnet (Multicall3, allowFailure; per-call reads on devnet / testnet where no Multicall3 is
// listed); configs and the protocol's price bounds once per 10 min; eth_estimateGas + eth_gasPrice + the transaction
// only for a position that is liquidatable at the fresh signed price.
import { type Db, enginePositions } from "@bookrunner/db";
import { KEYS, type Deployment, multicall3For } from "@bookrunner/shared";
import { LIQUIDATION_STATUS_TTL_SEC, type LiquidationKeeperStatus } from "@bookrunner/shared/liquidationKeeper";
import { attestedOracleAbi, bookrunnerConfigAbi, poolEngineAbi, stockTokenRegistryAbi } from "@bookrunner/shared/abi";
import { type EnginePosition, type EngineUnit, unitFromRevert } from "@bookrunner/shared/engineMath";
import { type SignedPrice, signedPriceFor } from "@bookrunner/shared/signedPrice";
import { and, eq, ne } from "drizzle-orm";
import type { Redis } from "ioredis";
import { type Address, BaseError, ContractFunctionRevertedError, type Hex, type PublicClient, encodeFunctionData, zeroAddress } from "viem";
import type { EngineMarketCfg, MarketRead } from "../domain/liquidation";
import type { TxSender } from "../kit/tx";
import type { LiqCall, LiquidationChain, PositionStore, SplitTokenState } from "../liquidationKeeper";

const posKey = (marketId: number, trader: string) => `${marketId}|${trader.toLowerCase()}`;

type Read = { address: Address; abi: typeof poolEngineAbi | typeof attestedOracleAbi | typeof bookrunnerConfigAbi | typeof stockTokenRegistryAbi; functionName: string; args?: readonly unknown[] };

/** The registry's custom error a transaction reverted with (NothingToRecord), if any. */
function registryRevertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
  return /NothingToRecord/.test(err.message) ? "NothingToRecord" : undefined;
}

/** The custom error a read reverted with, decoded with the engine's ABI (it names the split errors, audit N-1). */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

export class ViemLiquidationChain implements LiquidationChain {
  private readonly multicall: Address | null;

  constructor(
    private readonly pc: PublicClient,
    private readonly sender: TxSender,
    private readonly d: Pick<Deployment, "chainId" | "contracts">,
  ) {
    this.multicall = multicall3For(d.chainId);
  }

  private get engine(): Address {
    return this.d.contracts.poolEngine;
  }

  /** Reads in one aggregate3 (mainnet) or as parallel calls; a failed read is null. */
  private async batch(calls: Read[]): Promise<unknown[]> {
    if (this.multicall) {
      const res = (await this.pc.multicall({ contracts: calls as never, allowFailure: true, multicallAddress: this.multicall, batchSize: 0 })) as Array<{ status: string; result?: unknown }>;
      return res.map((r) => (r.status === "success" ? r.result : null));
    }
    return Promise.all(calls.map((c) => this.pc.readContract(c as never).catch(() => null)));
  }

  async readConfigs(marketIds: number[]) {
    const cfgAddr = this.d.contracts.config;
    const res = await this.batch([
      { address: cfgAddr, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" },
      { address: cfgAddr, abi: bookrunnerConfigAbi, functionName: "maxTradePriceAge" },
      ...marketIds.map((id) => ({ address: this.engine, abi: poolEngineAbi, functionName: "config", args: [BigInt(id)] })),
    ]);
    if (res[0] === null) throw new Error("config.maxPriceAge() unreadable");
    const cfgs = new Map<number, EngineMarketCfg>();
    marketIds.forEach((id, i) => {
      const c = res[i + 2] as { underlying: Hex; initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number } | null;
      if (c) cfgs.set(id, { underlying: c.underlying, initialMarginBps: Number(c.initialMarginBps), maintenanceMarginBps: Number(c.maintenanceMarginBps), liquidationFeeBps: Number(c.liquidationFeeBps) });
    });
    // an older config without the getter: the engine default (15 s)
    return { cfgs, params: { maxPriceAge: Number(res[0]), maxTradePriceAge: res[1] === null ? 15 : Number(res[1]) } };
  }

  async readPass(markets: Array<{ marketId: number; underlying: Hex }>, traders: Array<{ marketId: number; trader: string }>) {
    const oracle = this.d.contracts.oracle;
    const calls: Read[] = [
      ...markets.flatMap(({ marketId, underlying }) => [
        { address: this.engine, abi: poolEngineAbi, functionName: "state", args: [BigInt(marketId)] },
        { address: this.engine, abi: poolEngineAbi, functionName: "closeOutAfter", args: [BigInt(marketId)] },
        { address: oracle, abi: attestedOracleAbi, functionName: "latest", args: [underlying] },
        { address: oracle, abi: attestedOracleAbi, functionName: "settlePrice", args: [underlying] },
        { address: oracle, abi: attestedOracleAbi, functionName: "lastLiveAt", args: [underlying] },
      ]),
      ...traders.map((t) => ({ address: this.engine, abi: poolEngineAbi, functionName: "positionOf", args: [BigInt(t.marketId), t.trader as Address] })),
    ];
    const res = await this.batch(calls);
    const out = new Map<number, Omit<MarketRead, "cfg">>();
    markets.forEach(({ marketId }, i) => {
      const st = res[i * 5] as { fundingIndex: bigint; insuranceUsd: bigint; longSize: bigint; shortSize: bigint } | null;
      const co = res[i * 5 + 1] as bigint | null;
      const lt = res[i * 5 + 2] as { priceWad: bigint; publishedAt: bigint; held: boolean } | null;
      const sp = res[i * 5 + 3] as readonly [bigint, bigint, bigint, bigint, boolean] | null;
      const ll = res[i * 5 + 4] as bigint | null;
      // unreadable this pass (audit N-1: a frozen market's state() reverts too): skipped, retried next pass
      if (!st || co === null || !lt || ll === null) return;
      out.set(marketId, {
        marketId,
        fundingIndex: st.fundingIndex,
        insuranceUsd: st.insuranceUsd,
        closeOutAfter: Number(co),
        stored: lt.priceWad > 0n && lt.publishedAt > 0n ? { priceWad: lt.priceWad, publishedAt: Number(lt.publishedAt), held: lt.held } : null,
        settle: sp ? { priceWad: sp[0], effective: sp[4] } : null,
        lastLiveAt: Number(ll),
        netSize: st.longSize + st.shortSize,
      });
    });
    const positions = new Map<string, EnginePosition>();
    traders.forEach((t, i) => {
      const p = res[markets.length * 5 + i] as EnginePosition | null;
      if (p) positions.set(posKey(t.marketId, t.trader), { size: p.size, entryPriceWad: p.entryPriceWad, marginUsd: p.marginUsd, fundingIndexAtEntry: p.fundingIndexAtEntry });
    });
    return { markets: out, positions };
  }

  async readUnits(reqs: Array<{ marketId: number; basisAt: number }>): Promise<Map<number, EngineUnit>> {
    const out = new Map<number, EngineUnit>();
    // one read each: a revert names the split state (aggregate3 would hide the error name)
    await Promise.all(
      reqs.map(async ({ marketId, basisAt }) => {
        try {
          const unitWad = await this.pc.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "unitAt", args: [BigInt(marketId), BigInt(basisAt)] });
          out.set(marketId, { kind: "ok", unitWad });
        } catch (err) {
          const u = unitFromRevert(revertName(err));
          if (u) out.set(marketId, u);
        }
      }),
    );
    return out;
  }

  async syncUnit(marketId: number, priceData: Hex) {
    const out = await this.sender.send({ address: this.engine, abi: poolEngineAbi as never, functionName: "syncUnit", args: [BigInt(marketId), priceData], label: `syncUnit(market=${marketId})` });
    return { hash: out.hash, costWei: out.receipt.gasUsed * (out.receipt.effectiveGasPrice ?? 0n) };
  }

  async listMarkets() {
    const n = Number(await this.pc.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "marketCount" }));
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const res = await this.batch(ids.map((id) => ({ address: this.engine, abi: poolEngineAbi, functionName: "config", args: [BigInt(id)] })));
    return ids.flatMap((marketId, i) => {
      const c = res[i] as { underlying: Hex } | null;
      return c ? [{ marketId, underlying: c.underlying }] : [];
    });
  }

  private get registry(): Address | null {
    const r = this.d.contracts.stockRegistry;
    return r && r !== zeroAddress ? r : null;
  }

  async splitTokens(underlying: Hex): Promise<Address[]> {
    const reg = this.registry;
    if (!reg) return [];
    return [...(await this.pc.readContract({ address: reg, abi: stockTokenRegistryAbi, functionName: "splitTokens", args: [underlying] }))];
  }

  async splitStates(tokens: Address[]): Promise<SplitTokenState[]> {
    const reg = this.registry;
    if (!reg || tokens.length === 0) return [];
    const res = await this.batch(
      tokens.flatMap((t) => [
        { address: reg, abi: stockTokenRegistryAbi, functionName: "splitSyncNeeded", args: [t] },
        { address: reg, abi: stockTokenRegistryAbi, functionName: "splitUnrecorded", args: [t] },
      ]),
    );
    return tokens.map((token, i) => {
      const sync = res[i * 2] as boolean | null;
      const u = res[i * 2 + 1] as readonly [bigint, boolean] | null;
      return { token, syncNeeded: sync === true, unrecordedFrom: u === null ? null : Number(u[0]), latched: u?.[1] === true };
    });
  }

  async recordSplit(token: Address) {
    const reg = this.registry;
    if (!reg) throw new Error("no StockTokenRegistry in the deployment");
    try {
      const out = await this.sender.send({ address: reg, abi: stockTokenRegistryAbi as never, functionName: "recordSplit", args: [token], label: `recordSplit(${token})` });
      return { hash: out.hash as Hex | null, costWei: out.receipt.gasUsed * (out.receipt.effectiveGasPrice ?? 0n) };
    } catch (err) {
      // review L-4: someone else recorded (or latched) it first; nothing left to do is no failure
      if (registryRevertName(err) === "NothingToRecord") return { hash: null, costWei: 0n };
      throw err;
    }
  }

  private data(call: LiqCall): Hex {
    return encodeFunctionData({ abi: poolEngineAbi, functionName: call.functionName, args: [BigInt(call.marketId), call.trader as Address, call.priceData] });
  }

  estimate(call: LiqCall): Promise<bigint> {
    return this.pc.estimateGas({ account: this.sender.address, to: this.engine, data: this.data(call) });
  }

  gasPrice(): Promise<bigint> {
    return this.pc.getGasPrice();
  }

  async send(call: LiqCall, gas: bigint) {
    const out = await this.sender.send({
      address: this.engine,
      abi: poolEngineAbi as never,
      functionName: call.functionName,
      args: [BigInt(call.marketId), call.trader as Address, call.priceData],
      gas,
      label: `${call.functionName}(market=${call.marketId}, trader=${call.trader})`,
    });
    return { hash: out.hash, costWei: out.receipt.gasUsed * (out.receipt.effectiveGasPrice ?? 0n) };
  }
}

/** engine_positions (indexer): open rows each pass, every row for the reconciliation, and its size repair. */
export function pgPositionStore(db: Db): PositionStore {
  return {
    async open() {
      const rows = await db.select({ marketId: enginePositions.marketId, trader: enginePositions.trader }).from(enginePositions).where(ne(enginePositions.sizeRaw, "0"));
      return rows.map((r) => ({ marketId: r.marketId, trader: r.trader }));
    },
    async all() {
      const rows = await db.select({ marketId: enginePositions.marketId, trader: enginePositions.trader, sizeRaw: enginePositions.sizeRaw }).from(enginePositions);
      return rows.map((r) => ({ marketId: r.marketId, trader: r.trader, sizeRaw: String(r.sizeRaw) }));
    },
    async repair(marketId, trader, sizeRaw) {
      // the size only: the indexer's (block, logIndex) guard stays, its next event of the trader writes as usual
      await db
        .update(enginePositions)
        .set({ sizeRaw, updatedAt: new Date() })
        .where(and(eq(enginePositions.marketId, marketId), eq(enginePositions.trader, trader.toLowerCase())));
    },
  };
}

/** The freshest signed print per underlying from the oracle's bundle / per-key messages (KEYS.oracleBundle / oracleLast). */
export function redisSignedPrices(redis: Redis, domain: { chainId: number; oracle: Address }) {
  return async (underlyings: Hex[]): Promise<Map<string, SignedPrice>> => {
    const out = new Map<string, SignedPrice>();
    if (underlyings.length === 0) return out;
    const parse = (raw: string | null) => {
      try {
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    };
    const bundle = parse(await redis.get(KEYS.oracleBundle));
    // per-key messages only when the bundle lacks a market (an oracle in heartbeat mode)
    let messages: unknown[] = [];
    const missing = () => underlyings.some((u) => !signedPriceFor(bundle, [], u, domain));
    if (missing()) {
      // SCAN, never KEYS (review M-8: KEYS blocks production Redis)
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", KEYS.oracleLast("*"), "COUNT", 200);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0" && keys.length < 1000);
      messages = keys.length ? (await redis.mget(keys)).map(parse) : [];
    }
    for (const u of underlyings) {
      const s = signedPriceFor(bundle, messages, u, domain);
      if (s) out.set(u.toLowerCase(), s);
    }
    return out;
  };
}

/** The oracle's whole signed bundle (one round of every price id it publishes): what syncUnit carries (audit N-1). */
export function redisSignedBundle(redis: Redis, domain: { chainId: number; oracle: Address }) {
  return async (): Promise<Hex | null> => {
    try {
      const raw = await redis.get(KEYS.oracleBundle);
      const b = raw ? (JSON.parse(raw) as { priceData?: unknown; chainId?: unknown; oracle?: unknown }) : null;
      if (!b || typeof b.priceData !== "string" || !b.priceData.startsWith("0x") || b.priceData === "0x") return null;
      if (b.chainId !== undefined && b.chainId !== domain.chainId) return null;
      if (typeof b.oracle === "string" && b.oracle.toLowerCase() !== domain.oracle.toLowerCase()) return null;
      return b.priceData as Hex;
    } catch {
      return null;
    }
  };
}

export function redisStatusSink(redis: Redis) {
  return async (s: LiquidationKeeperStatus) => {
    await redis.set(KEYS.liquidationKeeper, JSON.stringify(s), "EX", LIQUIDATION_STATUS_TTL_SEC);
  };
}
