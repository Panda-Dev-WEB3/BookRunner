// viem / Postgres / Redis adapters of the liquidation keeper (liquidationKeeper.ts). RPC budget: one pass is ONE
// aggregate3 eth_call on mainnet (Multicall3, allowFailure; per-call reads on devnet / testnet where no Multicall3 is
// listed); configs and the protocol's price bounds once per 10 min; eth_estimateGas + eth_gasPrice + the transaction
// only for a position that is liquidatable at the fresh signed price.
import { type Db, enginePositions } from "@bookrunner/db";
import { KEYS, type Deployment, multicall3For } from "@bookrunner/shared";
import { LIQUIDATION_STATUS_TTL_SEC, type LiquidationKeeperStatus } from "@bookrunner/shared/liquidationKeeper";
import { attestedOracleAbi, bookrunnerConfigAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import type { EnginePosition } from "@bookrunner/shared/engineMath";
import { type SignedPrice, signedPriceFor } from "@bookrunner/shared/signedPrice";
import { and, eq, ne } from "drizzle-orm";
import type { Redis } from "ioredis";
import { type Address, type Hex, type PublicClient, encodeFunctionData } from "viem";
import type { EngineMarketCfg, MarketRead } from "../domain/liquidation";
import type { TxSender } from "../kit/tx";
import type { LiqCall, LiquidationChain, PositionStore } from "../liquidationKeeper";

const posKey = (marketId: number, trader: string) => `${marketId}|${trader.toLowerCase()}`;

type Read = { address: Address; abi: typeof poolEngineAbi | typeof attestedOracleAbi | typeof bookrunnerConfigAbi; functionName: string; args?: readonly unknown[] };

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
      ]),
      ...traders.map((t) => ({ address: this.engine, abi: poolEngineAbi, functionName: "positionOf", args: [BigInt(t.marketId), t.trader as Address] })),
    ];
    const res = await this.batch(calls);
    const out = new Map<number, Omit<MarketRead, "cfg">>();
    markets.forEach(({ marketId }, i) => {
      const st = res[i * 4] as { fundingIndex: bigint; insuranceUsd: bigint } | null;
      const co = res[i * 4 + 1] as bigint | null;
      const lt = res[i * 4 + 2] as { priceWad: bigint; publishedAt: bigint; held: boolean } | null;
      const sp = res[i * 4 + 3] as readonly [bigint, bigint, bigint, bigint, boolean] | null;
      if (!st || co === null || !lt) return; // unreadable this pass: skipped, retried next pass
      out.set(marketId, {
        marketId,
        fundingIndex: st.fundingIndex,
        insuranceUsd: st.insuranceUsd,
        closeOutAfter: Number(co),
        stored: lt.priceWad > 0n && lt.publishedAt > 0n ? { priceWad: lt.priceWad, publishedAt: Number(lt.publishedAt), held: lt.held } : null,
        settle: sp ? { priceWad: sp[0], effective: sp[4] } : null,
      });
    });
    const positions = new Map<string, EnginePosition>();
    traders.forEach((t, i) => {
      const p = res[markets.length * 4 + i] as EnginePosition | null;
      if (p) positions.set(posKey(t.marketId, t.trader), { size: p.size, entryPriceWad: p.entryPriceWad, marginUsd: p.marginUsd, fundingIndexAtEntry: p.fundingIndexAtEntry });
    });
    return { markets: out, positions };
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

export function redisStatusSink(redis: Redis) {
  return async (s: LiquidationKeeperStatus) => {
    await redis.set(KEYS.liquidationKeeper, JSON.stringify(s), "EX", LIQUIDATION_STATUS_TTL_SEC);
  };
}
