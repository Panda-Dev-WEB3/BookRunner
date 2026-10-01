// Per-book risk monitor: one tick = gather -> evaluate -> publish -> transitions -> effects.
// All infrastructure is behind ports (src/ports.ts) so the whole tick runs against fakes in tests.
import {
  HEDGE_BAND_GRACE_SECONDS,
  type LimitsSnapshot,
  type Logger,
  type QuotingVenue,
  RECEIPT_KIND,
  VENUE,
  bytes32ToStr,
} from "@bookrunner/shared";
import type { RiskSettings } from "./config";
import { type Evaluation, evaluate } from "./domain/evaluate";
import { venueDeployedValue } from "./domain/nav";
import { oracleFromRedis, oraclePrice } from "./domain/oracle";
import { finite, jsonSafe, receiptRow, usdNum, usdStr } from "./domain/records";
import { type Effect, decide, newKillJournal } from "./domain/transitions";
import { dedupe, emitDomainEvent } from "./events";
import { runKillSequence } from "./kill/sequence";
import type { BusPort, ChainPort, Clock, QueuePort, StorePort, VenueProvider } from "./ports";
import {
  type BookObservation,
  type BookRef,
  type BreachEpisode,
  type ChainObservation,
  type ExposureSource,
  type LiveNav,
  type MonitorState,
  type RiskMeta,
  type RiskStatePayload,
  initialMonitorState,
} from "./types";
import { type Sleep, errMsg, withTimeout } from "./util/async";

export interface MonitorDeps {
  chain: ChainPort;
  store: StorePort;
  bus: BusPort;
  queue: QueuePort;
  venues: VenueProvider;
  clock: Clock;
  settings: RiskSettings;
  log: Logger;
  sleep?: Sleep;
}

export interface TickResult {
  snapshot: LimitsSnapshot;
  effects: Array<Effect["kind"]>;
  killComplete: boolean | null;
}

/** Persisted state is read at most this many times before the monitor proceeds without it. */
const RESTORE_ATTEMPTS = 5;

export class BookMonitor {
  private state: MonitorState = initialMonitorState();
  private restored = false;
  private restoreFailures = 0;
  private tickNo = 0;
  private lastLimitsTick = Number.NEGATIVE_INFINITY;
  private lastLimitsSig: string | null = null;
  private venue: QuotingVenue | null = null;
  private venueResolved = false;
  private firstObservation = true;
  private lastPayload: RiskStatePayload | null = null;
  readonly log: Logger;

  constructor(
    readonly ref: BookRef,
    private readonly d: MonitorDeps,
  ) {
    this.log = d.log.child({ bookId: ref.bookId });
  }

  /** Current in-memory state machine (exposed for diagnostics/tests). */
  get monitorState(): MonitorState {
    return this.state;
  }

  async tick(): Promise<TickResult> {
    await this.restore();
    this.tickNo++;
    const s = this.d.settings;
    const nowMs = this.d.clock.nowMs();
    const nowSec = Math.floor(nowMs / 1000);

    const chainObs = await this.d.chain.observe(this.ref); // RPC failure -> tick fails -> loop backs off
    const obs = await this.assemble(chainObs, nowMs);
    const ev = evaluate(obs, this.state.band, {
      quoteMaxAgeMs: s.quoteMaxAgeMs,
      bandMaxGapSec: Math.max(60, Math.ceil((10 * s.intervalMs) / 1000)),
    });
    const { next, effects } = decide({
      bookId: this.ref.bookId,
      state: { ...this.state, band: ev.band },
      snapshot: ev.snapshot,
      killedOnChain: obs.killed,
      nowSec,
      confirmTicks: s.breachConfirmTicks,
      killMode: s.killMode,
    });
    // after a restart never trust a persisted "handled" marker blindly: verify against chain + DB once
    if (this.firstObservation && obs.killed && !next.kill && s.killMode === "enforce" && !effects.some((e) => e.kind === "check_kill_followup")) {
      effects.push({ kind: "check_kill_followup" });
    }
    this.firstObservation = false;
    this.state = next;

    // outputs first so agents/dashboards see a breach immediately, before the kill runs
    await this.publish(obs, ev);

    let killComplete: boolean | null = null;
    for (const e of effects) {
      try {
        if (e.kind === "emit_breach") await this.emitBreach(e.episode, obs, ev);
        else if (e.kind === "check_kill_followup") killComplete = await this.checkKillFollowup(obs, ev);
        else killComplete = await this.runKill(obs);
      } catch (err) {
        this.log.error({ effect: e.kind, err: errMsg(err) }, "risk effect failed; retrying next tick");
      }
    }
    if (effects.length) await this.persist();
    return { snapshot: ev.snapshot, effects: effects.map((e) => e.kind), killComplete };
  }

  // ------------------------------------------------------------------ gather

  private async assemble(c: ChainObservation, nowMs: number): Promise<BookObservation> {
    const ref = this.ref;
    const nowSec = Math.floor(nowMs / 1000);
    let netExposureUsd = c.adapter.netExposureUsd;
    let exposureSource: ExposureSource = ref.venue === VENUE.POOL_ENGINE ? "engine" : "adapter_report";
    let liveMmEquity: bigint | null = null;

    const venue = ref.venue === VENUE.ORDERLY ? await this.resolveVenue() : null;
    if (venue) {
      try {
        const a = await withTimeout(venue.account(), this.d.settings.venueTimeoutMs, "venue.account");
        netExposureUsd = a.position?.netExposureUsd ?? 0n;
        liveMmEquity = a.equityUsd;
        exposureSource = "venue_api";
      } catch (err) {
        this.log.warn({ err: errMsg(err) }, "venue API unavailable; using the adapter's last report");
      }
    }

    let oracle = c.oracle;
    if (!oracle) {
      const msg = await this.soft("oracleLast", () => this.d.bus.oracleLast(ref.priceIdStr), null);
      oracle = oracleFromRedis(msg, nowSec, c.maxPriceAgeSec);
    }
    const quote = await this.soft("latestQuote", () => this.d.bus.latestQuote(ref.bookId), null);

    return {
      bookId: ref.bookId,
      venue: ref.venue,
      nowMs,
      bookState: c.bookState,
      mandate: c.mandate,
      killed: c.killed,
      killReason: c.killReason,
      netExposureUsd,
      exposureSource,
      deskHedgeUsd: c.desk.hedgeNotionalUsd,
      nav: {
        vaultIdleUsd: c.vaultIdleUsd,
        unfundedClaimsUsd: c.unfundedClaimsUsd,
        venueDeployedUsd: venueDeployedValue(c.adapter, liveMmEquity),
        deskValueUsd: c.desk.valueUsd,
        seniorNavUsd: c.seniorNavUsd,
        juniorNavUsd: c.juniorNavUsd,
        perfIndexWad: c.perfIndexWad,
        highWaterWad: c.highWaterWad,
      },
      oracle,
      quote,
    };
  }

  private async resolveVenue(): Promise<QuotingVenue | null> {
    if (this.venueResolved) return this.venue;
    try {
      this.venue = await this.d.venues.forBook(this.ref);
      this.venueResolved = true;
      if (this.venue) this.log.info({ kind: this.venue.kind }, "live venue client attached");
    } catch (err) {
      this.log.warn({ err: errMsg(err) }, "venue client unavailable; retrying next tick");
      this.venue = null;
    }
    return this.venue;
  }

  // ------------------------------------------------------------------ outputs

  private async publish(obs: BookObservation, ev: Evaluation): Promise<void> {
    const snap = ev.snapshot;
    const meta = this.meta(obs, ev);
    const payload = jsonSafe<RiskStatePayload>({ ...snap, meta });
    this.lastPayload = payload;
    await this.soft("saveRiskState", () => this.d.bus.saveRiskState(this.ref.bookId, payload), undefined);
    await this.soft("saveLiveNav", () => this.d.bus.saveLiveNav(this.ref.bookId, this.liveNav(obs, ev)), undefined);

    const sig = `${snap.state}|${[...snap.breaches].sort().join(",")}`;
    if (sig !== this.lastLimitsSig || this.tickNo - this.lastLimitsTick >= this.d.settings.limitsEveryTicks) {
      try {
        await this.d.store.insertLimits({
          bookId: this.ref.bookId,
          ts: new Date(obs.nowMs),
          inventoryUtil: finite(snap.inventoryUtil),
          skewUtil: finite(snap.skewUtil),
          hedgeRatio: snap.hedgeRatioBps,
          drawdownBps: snap.drawdownBps,
          state: snap.state,
          offHours: snap.offHours,
          breaches: snap.breaches,
          netExposureUsd: usdNum(obs.netExposureUsd),
          liveNavUsd: usdNum(ev.nav.navUsd),
        });
        this.lastLimitsTick = this.tickNo;
        this.lastLimitsSig = sig;
      } catch (err) {
        this.log.warn({ err: errMsg(err) }, "limits row write failed");
      }
    }
  }

  private meta(obs: BookObservation, ev: Evaluation): RiskMeta {
    return {
      bookId: this.ref.bookId,
      mandate: this.ref.components.mandate.toLowerCase(),
      ts: obs.nowMs,
      tick: this.tickNo,
      venue: this.ref.venue === VENUE.POOL_ENGINE ? "engine" : "orderly",
      bookState: obs.bookState,
      maxInventoryUsd: usdStr(obs.mandate.maxInventoryUsd),
      netExposureUsd: usdStr(obs.netExposureUsd),
      exposureSource: obs.exposureSource,
      deskHedgeUsd: usdStr(obs.deskHedgeUsd),
      liveNavUsd: usdStr(ev.nav.navUsd),
      drawdownBps: ev.nav.drawdownBps,
      oracle: {
        priceId: this.ref.priceIdStr,
        price: oraclePrice(obs.oracle),
        publishedAt: obs.oracle.publishedAt,
        held: obs.oracle.held,
        stale: obs.oracle.stale,
        source: obs.oracle.source,
      },
      quote: ev.quote,
      hedgeBand: {
        inBand: ev.inBand,
        outOfBandSince: ev.band.outOfBandSince,
        outOfBandSec: ev.outOfBandSec,
        graceSec: HEDGE_BAND_GRACE_SECONDS,
      },
      killed: obs.killed,
      killReason: obs.killed ? bytes32ToStr(obs.killReason) || null : null,
      killMode: this.d.settings.killMode,
      monitor: this.state,
    };
  }

  private liveNav(obs: BookObservation, ev: Evaluation): LiveNav {
    const n = obs.nav;
    return {
      bookId: this.ref.bookId,
      ts: obs.nowMs,
      source: "risk",
      navUsd: usdStr(ev.nav.navUsd),
      vaultIdleUsd: usdStr(n.vaultIdleUsd),
      unfundedClaimsUsd: usdStr(n.unfundedClaimsUsd),
      venueDeployedUsd: usdStr(n.venueDeployedUsd),
      deskValueUsd: usdStr(n.deskValueUsd),
      accountedNavUsd: usdStr(ev.nav.accountedNavUsd),
      seniorNavUsd: usdStr(n.seniorNavUsd),
      juniorNavUsd: usdStr(n.juniorNavUsd),
      perfIndexWad: n.perfIndexWad.toString(),
      liveIndexWad: ev.nav.liveIndexWad.toString(),
      highWaterWad: ev.nav.highWaterWad.toString(),
      drawdownBps: ev.nav.drawdownBps,
      venueSource: obs.exposureSource,
    };
  }

  /** Re-saves the last published risk state with the current state machine (journal included). */
  private async persist(): Promise<void> {
    if (!this.lastPayload) return;
    const payload = jsonSafe<RiskStatePayload>({ ...this.lastPayload, meta: { ...this.lastPayload.meta, monitor: this.state } });
    this.lastPayload = payload;
    await this.soft("persistRiskState", () => this.d.bus.saveRiskState(this.ref.bookId, payload), undefined);
  }

  private async restore(): Promise<void> {
    if (this.restored) return;
    try {
      const p = await this.d.bus.loadRiskState(this.ref.bookId);
      const sameDeployment = p?.meta?.mandate?.toLowerCase() === this.ref.components.mandate.toLowerCase();
      if (p?.meta?.monitor && !sameDeployment) {
        this.log.warn({ storedMandate: p.meta.mandate ?? null }, "persisted risk state belongs to another deployment; ignoring it");
      } else if (p?.meta?.monitor) {
        this.state = { ...initialMonitorState(), ...p.meta.monitor };
        this.log.info(
          { lastState: this.state.lastState, killJournal: this.state.kill?.episodeId ?? null, handledKill: this.state.handledKill },
          "restored risk state",
        );
      }
      this.restored = true;
    } catch (err) {
      this.restoreFailures++;
      if (this.restoreFailures >= RESTORE_ATTEMPTS) {
        this.log.error({ err: errMsg(err) }, "could not restore persisted risk state; continuing from chain state only");
        this.restored = true;
        return;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ effects

  private snapshotJson(obs: BookObservation, ev: Evaluation, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return jsonSafe({
      ...ev.snapshot,
      netExposureUsd: usdStr(obs.netExposureUsd),
      exposureSource: obs.exposureSource,
      deskHedgeUsd: usdStr(obs.deskHedgeUsd),
      maxInventoryUsd: usdStr(obs.mandate.maxInventoryUsd),
      liveNavUsd: usdStr(ev.nav.navUsd),
      outOfBandSec: ev.outOfBandSec,
      quote: ev.quote,
      ...extra,
    });
  }

  private async emitBreach(episode: BreachEpisode, obs: BookObservation, ev: Evaluation): Promise<void> {
    const bookId = this.ref.bookId;
    const nowSec = Math.floor(obs.nowMs / 1000);
    const snapshot = this.snapshotJson(obs, ev, { episodeId: episode.id, since: episode.since });
    await emitDomainEvent(
      this.d.store,
      this.d.bus,
      "limit.breached",
      bookId,
      { bookId, breaches: episode.breaches, snapshot },
      dedupe.limitBreached(bookId, episode.id),
    );
    const decision = this.d.settings.killMode === "enforce" ? "kill" : "alert";
    await this.d.store.insertReceipt(
      receiptRow(
        bookId,
        RECEIPT_KIND.DECISION,
        nowSec,
        { type: "breach", bookId, episodeId: episode.id, breaches: episode.breaches, decision, snapshot },
        this.d.settings.receiptsIntervalSec,
      ),
    );
    if (this.state.episode && this.state.episode.id === episode.id) this.state.episode.notified = true;
    this.log.warn({ episodeId: episode.id, breaches: episode.breaches, decision }, "limit breached");
  }

  /** Mandate is killed on-chain and no journal of ours is open: make sure the kill's off-chain legs ran. */
  private async checkKillFollowup(obs: BookObservation, ev: Evaluation): Promise<boolean | null> {
    const ref = this.ref;
    const reason = bytes32ToStr(obs.killReason) || "UNKNOWN";
    if (reason === "RETIRE") {
      // wind-down (Book.retire): the agent stops quoting and flattens; this is not a risk kill
      if (this.state.handledKill !== "retire") this.log.info("mandate in RETIRE wind-down; no kill follow-up");
      this.state.handledKill = "retire";
      return null;
    }
    const k = await this.d.chain.latestKill(ref);
    const key = (k?.txHash ?? `reason:${reason}`).toLowerCase();
    if (this.state.handledKill === key) return null;
    const rows = await this.d.store.killEvents(ref.bookId);
    const recorded = rows.some((r) => (k ? r.txHashes.some((h) => h.toLowerCase() === key) : r.reason === reason));
    if (recorded) {
      this.state.handledKill = key;
      return null;
    }
    const nowSec = Math.floor(obs.nowMs / 1000);
    const ours = !!k && k.by.toLowerCase() === this.d.chain.riskAddress.toLowerCase();
    const j = newKillJournal(
      { id: `${ref.bookId}-kill-${k ? k.txHash.slice(2, 14).toLowerCase() : nowSec}`, breaches: [reason] },
      this.snapshotJson(obs, ev, { killReason: reason }),
      nowSec,
      "followup",
    );
    j.reason = reason;
    j.done = ["mandate_kill"];
    j.killTx = k?.txHash ?? null;
    j.txHashes = k ? [k.txHash] : [];
    j.actions = [ours ? "mandate_kill" : "mandate_kill:external", "revoke_desk_keys"];
    this.log.warn({ reason, killTx: j.killTx, by: k?.by ?? null }, "mandate killed without a recorded follow-up; running kill follow-up");
    this.state.kill = j;
    return this.runKill(obs);
  }

  private async runKill(obs: BookObservation): Promise<boolean> {
    const j = this.state.kill;
    if (!j) return false;
    await this.persist(); // journal durable before any side effect
    const venue = this.ref.venue === VENUE.ORDERLY ? await this.resolveVenue() : null;
    const res = await runKillSequence(
      j,
      { ref: this.ref, netExposureUsd: obs.netExposureUsd, deskHedgeUsd: obs.deskHedgeUsd, settings: this.d.settings, log: this.log },
      {
        chain: this.d.chain,
        store: this.d.store,
        bus: this.d.bus,
        queue: this.d.queue,
        venue,
        clock: this.d.clock,
        sleep: this.d.sleep,
      },
    );
    if (res.complete) {
      this.state.kill = null;
      this.state.handledKill = (res.journal.killTx ?? `episode:${res.journal.episodeId}`).toLowerCase();
    } else {
      this.state.kill = res.journal;
      this.log.error({ episodeId: j.episodeId, error: res.error, done: res.journal.done }, "kill sequence incomplete; resuming next tick");
    }
    return res.complete;
  }

  private async soft<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.log.warn({ op: label, err: errMsg(err) }, "non-critical read/write failed");
      return fallback;
    }
  }
}
