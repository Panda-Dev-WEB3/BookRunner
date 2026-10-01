// Watches contracts/deployments/<chainId>.json. While it is missing the API keeps serving DB data and
// chain-backed procedures answer PRECONDITION_FAILED; the file is re-checked periodically so a later
// `deploy:local` is picked up without a restart.
import { existsSync, statSync } from "node:fs";
import { type Deployment, type Logger, deploymentPath, publicClientFor, tryLoadDeployment } from "@bookrunner/shared";
import type { Kv } from "../kv";
import type { ChainGateway } from "./gateway";
import { ViemChainGateway } from "./viem";

export interface DeploymentWatcherOptions {
  file: string;
  chainId: number;
  rpcUrl: string;
  kv: Kv;
  cacheTtlSeconds: number;
  log: Logger;
  intervalMs?: number;
}

export class DeploymentWatcher {
  private gateway: ChainGateway | null = null;
  private mtimeMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnedAt = 0;

  constructor(private readonly o: DeploymentWatcherOptions) {}

  get current(): ChainGateway | null {
    return this.gateway;
  }

  get deployment(): Deployment | null {
    return this.gateway?.deployment ?? null;
  }

  /** Loads once now, then re-checks every intervalMs (default 10s). */
  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.o.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh() {
    const path = deploymentPath(this.o.file);
    try {
      if (!existsSync(path)) {
        this.gateway = null;
        this.mtimeMs = 0;
        if (Date.now() - this.warnedAt > 60_000) {
          this.warnedAt = Date.now();
          this.o.log.warn({ path }, "deployment file missing; chain-backed procedures unavailable (retrying)");
        }
        return;
      }
      const mtime = statSync(path).mtimeMs;
      if (this.gateway && mtime === this.mtimeMs) return;
      const d = tryLoadDeployment(this.o.file);
      if (!d) throw new Error("deployment file unreadable");
      if (d.chainId !== this.o.chainId) {
        this.o.log.error({ fileChainId: d.chainId, chainId: this.o.chainId }, "deployment chainId does not match CHAIN_ID; ignoring file");
        this.gateway = null;
        return;
      }
      const client = publicClientFor(this.o.chainId, this.o.rpcUrl);
      this.gateway = new ViemChainGateway(client, d, this.o.kv, this.o.cacheTtlSeconds);
      this.mtimeMs = mtime;
      this.o.log.info({ path, books: d.books.length, startBlock: d.startBlock }, "deployment loaded");
    } catch (err) {
      this.o.log.error({ err, path }, "failed to load deployment (retrying)");
    }
  }
}
