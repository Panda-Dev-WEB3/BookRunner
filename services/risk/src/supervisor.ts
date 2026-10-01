// Book discovery + monitor lifecycle. Idles (log + retry) while the deployment file is missing,
// rebuilds everything when the deployment changes, runs one independent loop per Live/Retiring book
// (a kill on one book never delays monitoring of the others).
import type { BookComponents, Deployment, Logger } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { RiskSettings } from "./config";
import { runMonitorLoop } from "./loop";
import { BookMonitor } from "./monitor";
import type { BusPort, ChainPort, Clock, DbBookRow, DiscoveryPort, QueuePort, StorePort, VenueProvider } from "./ports";
import type { BookRef } from "./types";
import { type Sleep, abortableSleep, errMsg } from "./util/async";

export type ChainGateway = ChainPort &
  DiscoveryPort & {
    loadRef(bookId: number, hint?: BookComponents): Promise<BookRef>;
    /** OrderlyAdapter.accountId(MM) — Orderly books only. */
    orderlyAccountId?(ref: BookRef): Promise<Hex>;
  };

export interface SupervisorDeps {
  settings: RiskSettings;
  log: Logger;
  store: StorePort;
  bus: BusPort;
  queue: QueuePort;
  clock: Clock;
  sleep?: Sleep;
  refreshMs: number;
  bookSource: "auto" | "chain" | "db";
  bookIds: Set<number> | null;
  chainId: number;
  loadDeployment(): Deployment | null;
  makeChain(dep: Deployment): ChainGateway;
  makeVenues(chain: ChainGateway): VenueProvider;
}

interface Handle {
  monitor: BookMonitor;
  ac: AbortController;
  done: Promise<void>;
}

const LIVE_STATES = new Set(["Live", "Retiring"]);

export class RiskSupervisor {
  private readonly monitors = new Map<number, Handle>();
  private readonly refs = new Map<number, BookRef>();
  private gateway: ChainGateway | null = null;
  private venues: VenueProvider | null = null;
  private depKey: string | null = null;
  private missingSince: number | null = null;
  private readonly lastWarn = new Map<string, { msg: string; at: number }>();

  constructor(private readonly d: SupervisorDeps) {}

  /** warn on first occurrence / when the error changes / once a minute; debug otherwise. */
  private warnThrottled(key: string, fields: Record<string, unknown>, msg: string): void {
    const now = this.d.clock.nowMs();
    const sig = JSON.stringify(fields);
    const prev = this.lastWarn.get(key);
    if (!prev || prev.msg !== sig || now - prev.at >= 60_000) {
      this.d.log.warn(fields, msg);
      this.lastWarn.set(key, { msg: sig, at: now });
    } else this.d.log.debug(fields, msg);
  }

  get activeBookIds(): number[] {
    return [...this.monitors.keys()].sort((a, b) => a - b);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.refresh();
      } catch (err) {
        this.warnThrottled("refresh", { err: errMsg(err) }, "book refresh failed; retrying");
      }
      await abortableSleep(this.d.refreshMs, signal);
    }
    await this.stopAll();
  }

  async refresh(): Promise<void> {
    const dep = this.d.loadDeployment();
    if (!dep) {
      if (this.missingSince === null) {
        this.missingSince = this.d.clock.nowMs();
        this.d.log.warn("deployment file missing (run `bun run deploy:local`); idling and retrying");
      } else this.d.log.debug("deployment file still missing");
      return;
    }
    if (dep.chainId !== this.d.chainId) {
      this.d.log.error({ deploymentChainId: dep.chainId, chainId: this.d.chainId }, "deployment chain id != CHAIN_ID; idling");
      return;
    }
    this.missingSince = null;
    const key = `${dep.chainId}:${dep.contracts.factory}:${dep.startBlock}`.toLowerCase();
    if (key !== this.depKey) {
      if (this.depKey) this.d.log.warn({ factory: dep.contracts.factory }, "deployment changed; restarting monitors");
      await this.stopAll();
      this.refs.clear();
      this.gateway = this.d.makeChain(dep);
      this.venues = this.d.makeVenues(this.gateway);
      this.depKey = key;
      this.d.log.info({ factory: dep.contracts.factory, startBlock: dep.startBlock }, "deployment loaded");
    }
    const gw = this.gateway;
    const venues = this.venues;
    if (!gw || !venues) return;

    const { live, keep } = await this.discover(gw);
    for (const ref of live) if (!this.monitors.has(ref.bookId)) this.start(ref, gw, venues);
    for (const id of [...this.monitors.keys()]) {
      if (!live.some((r) => r.bookId === id) && !keep.has(id)) await this.stop(id, "book no longer Live/Retiring");
    }
  }

  private async discover(gw: ChainGateway): Promise<{ live: BookRef[]; keep: Set<number> }> {
    let ids: number[] | null = null;
    let dbRows: DbBookRow[] | null = null;
    if (this.d.bookSource !== "db") {
      try {
        ids = await gw.listBookIds();
      } catch (err) {
        if (this.d.bookSource === "chain") throw err;
        this.warnThrottled("bookIds", { err: errMsg(err) }, "BookFactory.bookIds failed; falling back to the books table");
      }
    }
    if (ids === null) {
      dbRows = await this.d.store.liveBooks();
      ids = dbRows.map((r) => r.id);
    }
    const allow = this.d.bookIds;
    const live: BookRef[] = [];
    const keep = new Set<number>(); // transient read failure: keep a running monitor alive
    for (const id of ids.filter((x) => !allow || allow.has(x))) {
      try {
        let ref = this.refs.get(id);
        if (!ref) {
          const row = dbRows?.find((r) => r.id === id);
          ref = await gw.loadRef(id, row ? componentsFromRow(row) : undefined);
          this.refs.set(id, ref);
        }
        const state = await gw.bookState(ref);
        if (LIVE_STATES.has(state)) live.push(ref);
      } catch (err) {
        if (this.monitors.has(id)) keep.add(id);
        this.warnThrottled(`book:${id}`, { bookId: id, err: errMsg(err) }, "book discovery read failed");
      }
    }
    return { live, keep };
  }

  private start(ref: BookRef, chain: ChainGateway, venues: VenueProvider): void {
    const monitor = new BookMonitor(ref, {
      chain,
      store: this.d.store,
      bus: this.d.bus,
      queue: this.d.queue,
      venues,
      clock: this.d.clock,
      settings: this.d.settings,
      log: this.d.log,
      sleep: this.d.sleep,
    });
    const ac = new AbortController();
    const done = runMonitorLoop(monitor, ac.signal, this.d.settings.intervalMs, () => this.d.clock.nowMs());
    this.monitors.set(ref.bookId, { monitor, ac, done });
    this.d.log.info({ bookId: ref.bookId, symbol: ref.symbol, venue: ref.venue, mandate: ref.components.mandate }, "monitoring book");
  }

  private async stop(bookId: number, why: string): Promise<void> {
    const h = this.monitors.get(bookId);
    if (!h) return;
    h.ac.abort();
    await h.done;
    this.monitors.delete(bookId);
    this.d.log.info({ bookId, why }, "stopped monitoring book");
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.monitors.keys()].map((id) => this.stop(id, "shutdown")));
  }
}

function componentsFromRow(r: DbBookRow): BookComponents {
  const a = (x: string) => x as Address;
  return {
    book: a(r.bookAddr),
    senior: a(r.seniorAddr),
    junior: a(r.juniorAddr),
    vault: a(r.vaultAddr),
    mandate: a(r.mandateAddr),
    router: a(r.routerAddr),
    desk: a(r.deskAddr),
    adapter: a(r.adapterAddr),
  };
}
