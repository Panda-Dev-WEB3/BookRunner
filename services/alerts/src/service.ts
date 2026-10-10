// One alerting pass: collect -> evaluate rules -> dedupe state machine -> (rate-limited) delivery ->
// persist -> dead-man's switch ping. All I/O is injected, so a pass is testable end to end.
import type { Logger } from "@bookrunner/shared/logger";
import type { DeliveryConfig, RuleConfig } from "./config";
import { type AlertState, canSend, digestDue, emptyState, firing, markDigest, markSent, parseState, requeue, step, takeOutbox } from "./dedupe";
import type { Deliverer } from "./deliver";
import { type Message, noticeLine, renderBatch, renderDigest } from "./format";
import { type Memory, emptyMemory } from "./collect";
import { evaluate } from "./rules";
import type { Condition, Snapshot } from "./types";

export const STATE_KEY = "bkrn:alerts:state";
export const MEMORY_KEY = "bkrn:alerts:memory";

export interface StorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface ServiceDeps {
  collect: (mem: Memory) => Promise<{ snapshot: Snapshot; memory: Memory }>;
  deliverer: Deliverer;
  store: StorePort;
  log: Pick<Logger, "info" | "warn" | "error" | "debug">;
  now: () => number;
  heartbeat: () => Promise<boolean>;
  rules: RuleConfig;
  delivery: DeliveryConfig;
}

export interface PassResult {
  conditions: Condition[];
  sent: Message[];
  state: AlertState;
}

export class AlertService {
  private state: AlertState | null = null;
  private memory: Memory | null = null;

  constructor(private readonly d: ServiceDeps) {}

  private async load(): Promise<void> {
    if (this.state && this.memory) return;
    try {
      this.state = parseState(await this.d.store.get(STATE_KEY));
      const raw = await this.d.store.get(MEMORY_KEY);
      const m = raw ? (JSON.parse(raw) as Partial<Memory>) : null;
      this.memory = { ...emptyMemory(), ...(m && typeof m === "object" ? m : {}) };
    } catch (err) {
      // Redis down at start: begin empty (the infra rule reports Redis) and retry the load next pass
      this.d.log.warn({ err: String(err) }, "alert state not restored; starting empty");
      this.state ??= emptyState();
      this.memory ??= emptyMemory();
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.d.store.set(STATE_KEY, JSON.stringify(this.state));
      await this.d.store.set(MEMORY_KEY, JSON.stringify(this.memory));
    } catch (err) {
      this.d.log.debug({ err: String(err) }, "alert state not persisted (Redis)");
    }
  }

  /** Delivers one message; true when a channel took it (or there is no channel: logged only). */
  private async send(m: Message): Promise<boolean> {
    if (this.d.deliverer.channels.length === 0) {
      this.d.log.warn({ subject: m.subject }, `no alert channel configured; message logged only:\n${m.text}`);
      return true;
    }
    const results = await this.d.deliverer.deliver(m);
    for (const r of results) {
      if (r.ok) this.d.log.info({ channel: r.channel, subject: m.subject }, "alert delivered");
      else this.d.log.error({ channel: r.channel, error: r.error, subject: m.subject }, "alert delivery failed");
    }
    return results.some((r) => r.ok);
  }

  async tick(): Promise<PassResult> {
    await this.load();
    const { snapshot, memory } = await this.d.collect(this.memory!);
    this.memory = memory;
    const now = this.d.now();
    const conditions = evaluate(snapshot, this.d.rules);
    const { state, notices } = step(this.state!, conditions, now, { clearSec: this.d.delivery.clearSec });
    this.state = state;
    for (const n of notices) (n.kind === "resolved" ? this.d.log.info : this.d.log.warn).call(this.d.log, { key: n.key, kind: n.kind, severity: n.severity }, noticeLine(n));

    const sent: Message[] = [];
    if (canSend(this.state, now, this.d.delivery)) {
      const { batch, state: s } = takeOutbox(this.state);
      const m = renderBatch(this.d.delivery.label, batch, now);
      const ok = await this.send(m);
      this.state = ok ? markSent(s, now) : requeue(s, batch);
      if (ok) sent.push(m);
    }
    if (digestDue(this.state, now, this.d.delivery.digestHourUtc)) {
      const m = renderDigest(this.d.delivery.label, firing(this.state), this.state.history, now);
      if (await this.send(m)) {
        this.state = markDigest(this.state, now);
        sent.push(m);
      }
    }
    await this.persist();
    if (!(await this.d.heartbeat())) this.d.log.warn("dead-man's switch ping failed (ALERT_HEARTBEAT_URL)");
    return { conditions, sent, state: this.state };
  }
}
