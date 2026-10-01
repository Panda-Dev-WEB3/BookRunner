// Deployment watcher: loads contracts/deployments/<chain>.json (idles with retries while missing),
// builds chain clients, runs discovery and hands the universe to the service.
import { type Deployment, type Logger, publicClientFor, tryLoadDeployment, walletClientFor } from "@bookrunner/shared";
import type { LocalAccount } from "viem";
import { ViemChainReader, ViemOracleChain } from "./adapters/chain";
import type { OracleConfig } from "./config";
import { type DbReader, discoverUniverse } from "./discovery";
import { DEFAULT_SESSIONS } from "./domain/hold";
import type { OracleService } from "./service";
import { syntheticTicker } from "./sources/index";
import type { SyntheticMarket } from "./sources/synthetic";

interface Clients {
  key: string;
  chain: ViemOracleChain;
  reader: ViemChainReader;
}

export class Runtime {
  private clients: Clients | null = null;
  private lastWarnings = "";
  private lastWaitLog = 0;

  constructor(
    private readonly cfg: OracleConfig,
    private readonly log: Logger,
    private readonly service: OracleService,
    private readonly account: LocalAccount,
    private readonly db: DbReader | null,
    private readonly market: SyntheticMarket | null,
    private readonly loadDeployment: (file: string) => Deployment | null = tryLoadDeployment,
  ) {}

  /** One discovery pass; returns the delay until the next one. */
  async refresh(): Promise<number> {
    const dep = this.loadDeployment(this.cfg.DEPLOYMENT_FILE);
    if (!dep) return this.wait(`deployment file not found (${this.cfg.DEPLOYMENT_FILE}); run deploy:local`);
    if (dep.chainId !== this.cfg.CHAIN_ID) return this.wait(`deployment chainId ${dep.chainId} != CHAIN_ID ${this.cfg.CHAIN_ID}`);
    if (!dep.contracts?.oracle) return this.wait("deployment has no AttestedOracle address");

    const clients = this.clientsFor(dep);
    await this.service.setDeployment({
      chainId: dep.chainId,
      oracle: dep.contracts.oracle,
      chain: this.cfg.ORACLE_PUSH_ONCHAIN ? clients.chain : null,
    });

    const result = await discoverUniverse({
      deployment: dep,
      chain: clients.reader,
      db: this.db,
      cfg: { tickers: this.cfg.tickers, indexes: this.cfg.indexes, defaultSessions: DEFAULT_SESSIONS[this.cfg.ORACLE_DEFAULT_SESSIONS] },
    });
    const w = JSON.stringify(result.warnings);
    if (w !== this.lastWarnings) {
      this.lastWarnings = w;
      if (result.warnings.length > 0) this.log.warn({ warnings: result.warnings, source: result.source }, "universe discovery warnings");
    }
    if (this.market) {
      for (const e of result.entries) {
        if (e.kind === "equity" && !this.market.has(e.priceId)) {
          if (this.cfg.demoPrices[e.priceId] === undefined) this.log.warn({ priceId: e.priceId }, "no demo price configured; synthetic path starts at 100");
          this.market.addTicker(e.priceId, syntheticTicker(this.cfg, e.priceId));
        }
      }
    }
    await this.service.setUniverse(result.entries, result.source, result.warnings);
    return this.cfg.ORACLE_UNIVERSE_REFRESH_MS;
  }

  private wait(reason: string): number {
    this.service.setWaiting(reason);
    const now = Date.now();
    if (now - this.lastWaitLog > 60_000) {
      this.lastWaitLog = now;
      this.log.info({ retryInMs: this.cfg.ORACLE_DEPLOYMENT_RETRY_MS }, `idle: ${reason}`);
    }
    return this.cfg.ORACLE_DEPLOYMENT_RETRY_MS;
  }

  private clientsFor(dep: Deployment): Clients {
    const key = `${dep.chainId}|${this.cfg.RPC_URL}|${dep.contracts.oracle}|${dep.contracts.stockRegistry}`;
    if (this.clients?.key === key) return this.clients;
    const pub = publicClientFor(dep.chainId, this.cfg.RPC_URL);
    const wallet = walletClientFor(dep.chainId, this.cfg.RPC_URL, this.account);
    this.clients = {
      key,
      chain: new ViemOracleChain(pub, wallet, dep.contracts.oracle, dep.chainId, this.log, this.cfg.ORACLE_RECEIPT_TIMEOUT_MS),
      reader: new ViemChainReader(pub, dep.contracts.stockRegistry),
    };
    this.log.info({ chainId: dep.chainId, oracle: dep.contracts.oracle, registry: dep.contracts.stockRegistry }, "deployment loaded");
    return this.clients;
  }
}
