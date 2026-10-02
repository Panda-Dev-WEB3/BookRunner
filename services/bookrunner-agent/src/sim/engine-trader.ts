// One simulated trader account on the in-house PoolEngine: devnet USDC mint (MockERC20), approve,
// depositMargin, trade with an acceptable price, close, liquidate others. Pull oracle (docs/LOW_GAS.md
// §1): with `pull`, trades and liquidations carry the freshest signed prices through the
// trade(..., priceData) / liquidate(..., priceData) overloads (the trader pays the oracle update in its
// own tx); without priceData (or on a legacy engine) the 3-arg trade / 2-arg liquidate. Txs per account
// are serialized (one nonce stream per trader across markets).

import type { Logger } from "@bookrunner/shared";
import { attestedOracleAbi, mockERC20Abi, poolEngineAbi } from "@bookrunner/shared/abi";
import { type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient, maxUint256 } from "viem";
import { RECEIPT_POLL_MS } from "../chain/desk-client";
import { enginePullAbi, mergeAbi } from "../chain/lowgas-abi";
import { SerialLock } from "../util";

/** PoolEngine ABI + the trade/liquidate priceData overloads + AttestedOracle errors (in-tx update). */
export const ENGINE_PULL_ABI: Abi = mergeAbi(
  poolEngineAbi as unknown as Abi,
  enginePullAbi,
  attestedOracleAbi.filter((x) => (x as { type: string }).type === "error") as unknown as Abi,
);

export interface PoolView {
  reduceOnly: boolean;
  poolExposureUsd: bigint;
  maxNetExposureUsd: bigint;
  spreadBps: number;
  skewBps: number;
  maintenanceMarginBps: number;
}

export interface EnginePosition {
  size: bigint;
  entryPriceWad: bigint;
  marginUsd: bigint;
}

export class EngineTrader {
  private readonly lock = new SerialLock();
  private approved = false;

  constructor(
    readonly name: string,
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    private readonly engine: Address,
    private readonly usdc: Address,
    private readonly log: Logger,
    private readonly timeoutMs: number,
    private readonly canMint: boolean,
    /** the deployed engine has the priceData overloads (trade / liquidate) */
    private readonly pull: { trade: boolean; liquidate: boolean } = { trade: false, liquidate: false },
  ) {}

  get pullTrade(): boolean {
    return this.pull.trade;
  }

  get pullLiquidate(): boolean {
    return this.pull.liquidate;
  }

  get address(): Address {
    return this.wallet.account.address;
  }

  private async send(label: string, fn: () => Promise<Hex>): Promise<Hex> {
    const hash = await fn();
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: this.timeoutMs, pollingInterval: RECEIPT_POLL_MS });
    if (r.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
    this.log.info({ trader: this.name, label, txHash: hash, block: r.blockNumber.toString() }, "sim tx confirmed");
    return hash;
  }

  async position(marketId: bigint): Promise<EnginePosition> {
    const p = await this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "positionOf", args: [marketId, this.address] });
    return { size: p.size, entryPriceWad: p.entryPriceWad, marginUsd: p.marginUsd };
  }

  /** Pool-side gate inputs: reduce-only flag, current pool exposure and its cap (USD 6dp), quote params. */
  async poolView(marketId: bigint): Promise<PoolView> {
    const [st, cfg, exp] = await Promise.all([
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "state", args: [marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "config", args: [marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "netExposureUsd", args: [marketId] }),
    ]);
    return {
      reduceOnly: st.reduceOnly,
      poolExposureUsd: exp,
      maxNetExposureUsd: cfg.maxNetExposureUsd,
      spreadBps: Number(st.spreadBps),
      skewBps: Number(st.skewBps),
      maintenanceMarginBps: Number(cfg.maintenanceMarginBps),
    };
  }

  quotePrice(marketId: bigint, sizeDelta: bigint): Promise<bigint> {
    return this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "quotePrice", args: [marketId, sizeDelta] });
  }

  /** Keep at least half of targetUsd as margin on the market (mints devnet USDC when short). */
  ensureMargin(marketId: bigint, targetUsd: bigint, mintUsd: bigint): Promise<void> {
    return this.lock.run(async () => {
      const pos = await this.position(marketId);
      if (pos.marginUsd * 2n >= targetUsd) return;
      const need = targetUsd - pos.marginUsd;
      const bal = await this.pub.readContract({ address: this.usdc, abi: mockERC20Abi, functionName: "balanceOf", args: [this.address] });
      if (bal < need) {
        if (!this.canMint) throw new Error(`${this.name}: USDC balance ${bal} below margin need ${need} (mint only on devnet)`);
        const amount = mintUsd > need ? mintUsd : need;
        await this.send("mint", () => this.wallet.writeContract({ address: this.usdc, abi: mockERC20Abi, functionName: "mint", args: [this.address, amount] }));
      }
      if (!this.approved) {
        const allowance = await this.pub.readContract({ address: this.usdc, abi: mockERC20Abi, functionName: "allowance", args: [this.address, this.engine] });
        if (allowance < need) {
          await this.send("approve", () => this.wallet.writeContract({ address: this.usdc, abi: mockERC20Abi, functionName: "approve", args: [this.engine, maxUint256] }));
        }
        this.approved = true;
      }
      const hash = await this.send("depositMargin", () =>
        this.wallet.writeContract({ address: this.engine, abi: poolEngineAbi, functionName: "depositMargin", args: [marketId, need] }),
      );
      this.log.info({ trader: this.name, marketId: marketId.toString(), amountUsd: need.toString(), txHash: hash }, "sim margin deposited");
    });
  }

  /**
   * Simulate then send trade(marketId, sizeDelta, acceptablePriceWad[, priceData]): the priceData overload
   * when prices are given and the engine has it, else the 3-arg trade on the stored price.
   */
  trade(marketId: bigint, sizeDelta: bigint, acceptablePriceWad: bigint, priceData: Hex | null = null): Promise<Hex> {
    return this.lock.run(async () => {
      const withPrices = !!priceData && this.pull.trade;
      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: this.engine,
        abi: ENGINE_PULL_ABI,
        functionName: "trade",
        args: withPrices ? [marketId, sizeDelta, acceptablePriceWad, priceData] : [marketId, sizeDelta, acceptablePriceWad],
      });
      return this.send(withPrices ? "trade+prices" : "trade", () => this.wallet.writeContract(request as never));
    });
  }

  /**
   * Liquidate `trader` if the engine accepts it (simulated first; NotLiquidatable etc. -> null, no tx).
   * Carries priceData through the liquidate(..., priceData) overload when available: the margin check
   * runs at the fresh price.
   */
  liquidate(marketId: bigint, trader: Address, priceData: Hex | null = null): Promise<Hex | null> {
    return this.lock.run(async () => {
      const withPrices = !!priceData && this.pull.liquidate;
      let request: unknown;
      try {
        ({ request } = await this.pub.simulateContract({
          account: this.wallet.account,
          address: this.engine,
          abi: ENGINE_PULL_ABI,
          functionName: "liquidate",
          args: withPrices ? [marketId, trader, priceData] : [marketId, trader],
        }));
      } catch {
        return null;
      }
      return this.send(withPrices ? "liquidate+prices" : "liquidate", () => this.wallet.writeContract(request as never));
    });
  }
}
