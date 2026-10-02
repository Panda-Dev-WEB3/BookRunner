// viem adapter: book discovery, per-tick reads and RISK-role writes. Every write is simulated
// first, sent from roleAccount("risk") with a buffered gas limit, serialised through one mutex
// (single nonce stream) and awaited to a successful receipt; tx hashes are logged.
import {
  ACCOUNT,
  BOOK_STATE,
  type BookComponents,
  type BookState,
  type Deployment,
  HEDGE_VENUES,
  type Logger,
  VENUE,
  type VenueId,
  bytes32ToStr,
  strToBytes32,
} from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bookAbi,
  bookFactoryAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  mMMandateAbi,
  orderlyAdapterAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  erc20Abi,
  parseAbiParameters,
  zeroHash,
} from "viem";
import type { FlattenOrder, Holding } from "../domain/flatten";
import { stockValueUsd } from "../domain/flatten";
import { oracleFromChain } from "../domain/oracle";
import type { ChainPort, DiscoveryPort, KillLog } from "../ports";
import type { BookRef, ChainObservation, OracleReading } from "../types";
import { Mutex, errMsg } from "../util/async";

/** BookrunnerDesk.ActionKind.Flatten */
export const ACTION_FLATTEN = 6;
const FLATTEN_PARAMS = parseAbiParameters("address token, uint256 amountIn, uint256 minAmountOut, uint24 poolFee, bytes32 venue");
const MAX_PRICE_AGE_TTL_MS = 60_000;

export interface ViemChainOptions {
  txTimeoutMs: number;
  killLogLookbackBlocks: number;
  log: Logger;
}

export class ViemChain implements ChainPort, DiscoveryPort {
  readonly riskAddress: Address;
  private readonly mutex = new Mutex();
  private maxPriceAge: { value: number; at: number } | null = null;

  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    readonly deployment: Deployment,
    private readonly o: ViemChainOptions,
  ) {
    this.riskAddress = wallet.account.address;
  }

  private get c() {
    return this.deployment.contracts;
  }

  // ------------------------------------------------------------------ discovery

  async listBookIds(): Promise<number[]> {
    const ids = await this.pub.readContract({ address: this.c.factory, abi: bookFactoryAbi, functionName: "bookIds" });
    return ids.map((x) => Number(x));
  }

  async loadRef(bookId: number, hint?: BookComponents): Promise<BookRef> {
    const components: BookComponents =
      hint ??
      (await this.pub.readContract({ address: this.c.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [BigInt(bookId)] }));
    const charter = await this.pub.readContract({ address: components.book, abi: bookAbi, functionName: "getCharter" });
    const priceId = await this.pub.readContract({
      address: this.c.stockRegistry,
      abi: stockTokenRegistryAbi,
      functionName: "priceIdOf",
      args: [charter.underlying],
    });
    return {
      bookId,
      venue: charter.venue as VenueId,
      components: { ...components },
      underlying: charter.underlying,
      priceId,
      priceIdStr: safeStr(priceId),
      symbol: safeStr(charter.symbol),
    };
  }

  async bookState(ref: BookRef): Promise<BookState> {
    const s = await this.pub.readContract({ address: ref.components.book, abi: bookAbi, functionName: "state" });
    return BOOK_STATE[s] ?? "Subscription";
  }

  /** Orderly: last on-chain capital flow (deposit/confirm/cancel), 0 if unreadable. */
  async orderlyLastFlowAt(ref: BookRef): Promise<number> {
    try {
      return Number(await this.pub.readContract({ address: ref.components.adapter, abi: orderlyAdapterAbi, functionName: "lastFlowAt" }));
    } catch {
      return 0;
    }
  }

  /** Orderly MM account id (bytes32) held by the OrderlyAdapter. */
  async orderlyAccountId(ref: BookRef, account: number = ACCOUNT.MM): Promise<Hex> {
    return this.pub.readContract({ address: ref.components.adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [account] });
  }

  // ------------------------------------------------------------------ reads

  async observe(ref: BookRef): Promise<ChainObservation> {
    const k = ref.components;
    const p = this.pub;
    const [
      state,
      mandate,
      killed,
      killReason,
      netExposureUsd,
      deployedValueUsd,
      insuranceEquityUsd,
      inTransitUsd,
      valuationAt,
      hedgeNotionalUsd,
      deskValueUsd,
      vaultIdleUsd,
      unfundedClaimsUsd,
      perf,
      nav,
    ] = await Promise.all([
      p.readContract({ address: k.book, abi: bookAbi, functionName: "state" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "getMandate" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "killed" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "killReason" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "deployedValueUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "insuranceEquityUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "inTransitUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "valuationAt" }),
      // both revert StalePrice (registry.valueUsd -> oracle.priceOf) once a held token's price is
      // older than maxPriceAge: caught here and re-valued at the last attested price below, so a
      // degraded oracle never blinds the venue-exposure limits or the kill path
      p.readContract({ address: k.desk, abi: bookrunnerDeskAbi, functionName: "hedgeNotionalUsd" }).catch(() => null),
      p.readContract({ address: k.desk, abi: bookrunnerDeskAbi, functionName: "valueUsd" }).catch(() => null),
      p.readContract({ address: k.vault, abi: underwritingVaultAbi, functionName: "idle" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "unfundedClaims" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "perfIndex" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "trancheNav" }),
    ]);
    const [oracle, maxPriceAgeSec] = await Promise.all([this.readOracle(ref.priceId), this.readMaxPriceAge()]);
    const desk =
      hedgeNotionalUsd !== null && deskValueUsd !== null
        ? { hedgeNotionalUsd, valueUsd: deskValueUsd, priceStale: false }
        : await this.deskAtLastPrice(ref);
    return {
      bookState: BOOK_STATE[state] ?? "Subscription",
      mandate: { ...mandate },
      killed,
      killReason,
      adapter: {
        netExposureUsd,
        deployedValueUsd,
        insuranceEquityUsd,
        inTransitUsd,
        valuationAt: Number(valuationAt),
        lastFlowAt: ref.venue === VENUE.ORDERLY ? await this.orderlyLastFlowAt(ref) : 0,
      },
      desk,
      vaultIdleUsd,
      unfundedClaimsUsd,
      seniorNavUsd: nav[0],
      juniorNavUsd: nav[1],
      perfIndexWad: perf[0],
      highWaterWad: perf[1],
      oracle,
      maxPriceAgeSec,
    };
  }

  /**
   * Desk valuation when the on-chain views revert (stale price): every held token valued through
   * the registry at its last attested price (valueUsdAt; multiplier applied exactly once there),
   * plus the desk's USDC. Flagged priceStale so dashboards show the degraded valuation.
   */
  private async deskAtLastPrice(ref: BookRef): Promise<ChainObservation["desk"]> {
    const [holdings, usdc] = await Promise.all([
      this.deskHoldings(ref),
      this.pub.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ref.components.desk] }),
    ]);
    const hedge = holdings.reduce((sum, h) => sum + h.valueUsd, 0n);
    this.o.log.warn(
      { bookId: ref.bookId, hedgeUsd: hedge.toString(), tokens: holdings.length },
      "desk valuation reverted (stale oracle price); using the last attested prices",
    );
    return { hedgeNotionalUsd: hedge, valueUsd: usdc + hedge, priceStale: true };
  }

  private async readOracle(priceId: Hex): Promise<OracleReading | null> {
    try {
      const [latest, stale] = await Promise.all([
        this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId] }),
        this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "isStale", args: [priceId] }),
      ]);
      return oracleFromChain(latest, stale);
    } catch (err) {
      this.o.log.debug({ priceId, err: errMsg(err) }, "oracle read failed; falling back to redis");
      return null;
    }
  }

  private async readMaxPriceAge(): Promise<number> {
    const now = Date.now();
    if (this.maxPriceAge && now - this.maxPriceAge.at < MAX_PRICE_AGE_TTL_MS) return this.maxPriceAge.value;
    try {
      const v = await this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" });
      this.maxPriceAge = { value: Number(v), at: now };
      return Number(v);
    } catch {
      return this.maxPriceAge?.value ?? 300;
    }
  }

  async isKilled(ref: BookRef): Promise<boolean> {
    return this.pub.readContract({ address: ref.components.mandate, abi: mMMandateAbi, functionName: "killed" });
  }

  async latestKill(ref: BookRef): Promise<KillLog | null> {
    const latest = await this.pub.getBlockNumber();
    const start = BigInt(Math.max(0, this.deployment.startBlock ?? 0));
    const lookback = BigInt(this.o.killLogLookbackBlocks);
    const fromBlock = lookback > 0n && latest - lookback > start ? latest - lookback : start;
    const logs = await this.pub.getContractEvents({
      address: ref.components.mandate,
      abi: mMMandateAbi,
      eventName: "Kill",
      fromBlock,
      toBlock: latest,
    });
    const last = logs.at(-1);
    if (!last || !last.transactionHash) return null;
    return {
      txHash: last.transactionHash,
      reason: last.args.reason ?? zeroHash,
      by: last.args.by ?? "0x0000000000000000000000000000000000000000",
      blockNumber: last.blockNumber ?? 0n,
    };
  }

  async deskHoldings(ref: BookRef): Promise<Holding[]> {
    const desk = ref.components.desk;
    const tokens = await this.pub.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "heldTokens" });
    return Promise.all(
      tokens.map(async (token): Promise<Holding> => {
        const [qtyRaw, info] = await Promise.all([
          this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [desk] }),
          this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] }),
        ]);
        let priceWad = 0n;
        try {
          const l = await this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [info.priceId] });
          priceWad = l.priceWad;
        } catch (err) {
          this.o.log.warn({ token, err: errMsg(err) }, "no oracle price for desk token");
        }
        let valueUsd = 0n;
        if (priceWad > 0n && qtyRaw > 0n) {
          try {
            // registry valuation is normative (multiplier applied exactly once)
            valueUsd = await this.pub.readContract({
              address: this.c.stockRegistry,
              abi: stockTokenRegistryAbi,
              functionName: "valueUsdAt",
              args: [token, qtyRaw, priceWad],
            });
          } catch {
            valueUsd = stockValueUsd(qtyRaw, info.multiplierWad, priceWad, info.decimals);
          }
        }
        return { token, qtyRaw, valueUsd, priceWad, multiplierWad: info.multiplierWad, decimals: info.decimals };
      }),
    );
  }

  // ------------------------------------------------------------------ writes (RISK role)

  async setReduceOnly(ref: BookRef): Promise<Hex> {
    return this.submit(`adapter.setReduceOnly(book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.adapter,
        abi: poolEngineAdapterAbi,
        functionName: "setReduceOnly",
        args: [true],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  async flatten(ref: BookRef, order: FlattenOrder, poolFee: number): Promise<Hex> {
    const data = encodeAbiParameters(FLATTEN_PARAMS, [order.token, order.amountIn, order.minAmountOut, poolFee, HEDGE_VENUES.UNIV3]);
    return this.submit(`desk.execute(Flatten ${order.token}, book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.desk,
        abi: bookrunnerDeskAbi,
        functionName: "execute",
        args: [{ kind: ACTION_FLATTEN, data, proof: [] }],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  async mandateKill(ref: BookRef, reason: string): Promise<Hex> {
    const reasonBytes = strToBytes32(reason.slice(0, 32));
    return this.submit(`mandate.kill(${reason}, book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.mandate,
        abi: mMMandateAbi,
        functionName: "kill",
        args: [reasonBytes],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  private submit(label: string, send: () => Promise<Hex>): Promise<Hex> {
    return this.mutex.run(async () => {
      const hash = await send();
      this.o.log.info({ tx: hash, op: label, from: this.riskAddress }, "tx sent");
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.o.txTimeoutMs });
      if (receipt.status !== "success") throw new Error(`${label} reverted in ${hash}`);
      this.o.log.info({ tx: hash, op: label, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }, "tx confirmed");
      return hash;
    });
  }
}

/**
 * Gas limit from an eth_estimateGas result: +30% + 30k. Kill-path txs (mandate.kill revokes every
 * key, desk Flatten swaps through the executor, adapter.setReduceOnly reaches the engine) are
 * nested calls whose inner frames get only 63/64 of the remaining gas; a tight estimate made at a
 * different state can OOG them exactly when they matter.
 */
export const bufferedGas = (estimate: bigint): bigint => (estimate * 13n) / 10n + 30_000n;

function safeStr(b: Hex): string {
  try {
    return bytes32ToStr(b) || b;
  } catch {
    return b;
  }
}
