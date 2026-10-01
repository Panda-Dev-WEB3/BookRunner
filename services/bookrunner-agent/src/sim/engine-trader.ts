// One simulated trader account on the in-house PoolEngine: devnet USDC mint (MockERC20), approve,
// depositMargin, trade with an acceptable price, close. Txs per account are serialized (one nonce
// stream per trader across markets).

import type { Logger } from "@bookrunner/shared";
import { mockERC20Abi, poolEngineAbi } from "@bookrunner/shared/abi";
import { type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient, maxUint256 } from "viem";
import { RECEIPT_POLL_MS } from "../chain/desk-client";
import { SerialLock } from "../util";

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
  ) {}

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

  /** Pool-side gate inputs: reduce-only flag, current pool exposure and its cap (USD 6dp). */
  async poolView(marketId: bigint): Promise<{ reduceOnly: boolean; poolExposureUsd: bigint; maxNetExposureUsd: bigint }> {
    const [st, cfg, exp] = await Promise.all([
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "state", args: [marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "config", args: [marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "netExposureUsd", args: [marketId] }),
    ]);
    return { reduceOnly: st.reduceOnly, poolExposureUsd: exp, maxNetExposureUsd: cfg.maxNetExposureUsd };
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

  /** Simulate then send trade(marketId, sizeDelta, acceptablePriceWad). */
  trade(marketId: bigint, sizeDelta: bigint, acceptablePriceWad: bigint): Promise<Hex> {
    return this.lock.run(async () => {
      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: this.engine,
        abi: poolEngineAbi,
        functionName: "trade",
        args: [marketId, sizeDelta, acceptablePriceWad],
      });
      return this.send("trade", () => this.wallet.writeContract(request));
    });
  }
}
