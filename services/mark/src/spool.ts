// Local spool for committed-mark rows that could not be written to Postgres right after the on-chain
// commit (the pnl JSON exists only off-chain; losing it would make the committed hash unverifiable).
// Rows are flushed into the DB on the next successful tick.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type MarkInput, type MarkPnl, REPO_ROOT } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { MarkRow } from "./ports";

const big = (v: unknown) => BigInt(String(v));

export function serializeMarkRow(r: MarkRow): string {
  return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v));
}

export function deserializeMarkRow(s: string): MarkRow {
  const o = JSON.parse(s) as Record<string, unknown> & { input: Record<string, unknown>; preview: Record<string, unknown> };
  const input: MarkInput = {
    bookId: big(o.input.bookId),
    periodEnd: big(o.input.periodEnd),
    navUsd: big(o.input.navUsd),
    deployedValueUsd: big(o.input.deployedValueUsd),
    flowNonce: big(o.input.flowNonce),
    inventoryRoot: o.input.inventoryRoot as Hex,
    pnlJsonHash: o.input.pnlJsonHash as Hex,
    receiptsRoot: o.input.receiptsRoot as Hex,
    held: o.input.held === true, // spooled before audit M-1: not held
  };
  return {
    markId: Number(o.markId),
    bookId: Number(o.bookId),
    periodEnd: Number(o.periodEnd),
    input,
    pnl: o.pnl as MarkPnl,
    signer: o.signer as Address,
    signature: o.signature as Hex,
    commitTx: o.commitTx as Hex,
    committedAt: new Date(String(o.committedAt)),
    preview: {
      seniorNav: big(o.preview.seniorNav),
      juniorNav: big(o.preview.juniorNav),
      seniorPrice: big(o.preview.seniorPrice),
      juniorPrice: big(o.preview.juniorPrice),
      pnlUsd: big(o.preview.pnlUsd),
    },
  };
}

export class MarkSpool {
  /** Absolute spool directory: a relative MARK_SPOOL_DIR resolves against the repo root (like OPS_KEYS_DIR), not the
   *  service's cwd (services/mark, read-only under the systemd sandbox; the writable state is .data/). */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
  }

  write(r: MarkRow): string {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `mark-${r.markId}.json`);
    writeFileSync(file, serializeMarkRow(r));
    return file;
  }

  pending(): MarkRow[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^mark-\d+\.json$/.test(f))
      .map((f) => deserializeMarkRow(readFileSync(join(this.dir, f), "utf8")));
  }

  remove(markId: number) {
    const file = join(this.dir, `mark-${markId}.json`);
    if (existsSync(file)) unlinkSync(file);
  }

  /** Writes spooled rows through `save`; returns the number flushed. */
  async flush(save: (r: MarkRow) => Promise<void>): Promise<number> {
    let n = 0;
    for (const r of this.pending()) {
      await save(r);
      this.remove(r.markId);
      n++;
    }
    return n;
  }
}
