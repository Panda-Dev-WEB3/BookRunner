// Per-book Orderly key store. Devnet: JSON files under .data/keys/<bookId>.json (mode 0600).
// VERIFY for mainnet: move secrets to a proper secret store (KMS/HSM-backed signer or Vault); this
// module is the only place secrets touch disk, and venue_accounts only ever records key PREFIXES.
//   trade  — the book's MM-account key, scope "read,trading" (never "asset": cannot withdraw)
//   ops.if / ops.mm — ops-venue keys, scope "read,asset" (reports, withdrawals, key removal)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { REPO_ROOT } from "@bookrunner/shared";
import { type Ed25519Key, generateKey, keyFromSecret, keyPrefix, secretToString } from "./orderly/auth";

export const TRADE_SCOPE = "read,trading";
export const OPS_SCOPE = "read,asset";
export const BUILDER_SCOPE = "read,trading,asset";

export interface StoredKey {
  accountId: string;
  orderlyKey: string;
  secret: string; // base58 ed25519 seed
  scope: string;
  createdAt: number;
  expiration: number; // ms
  registeredAt: number | null;
  revokedAt: number | null;
  revokeReason?: string;
}

export interface BookKeyFile {
  bookId: number;
  trade: StoredKey | null;
  ops: { if: StoredKey | null; mm: StoredKey | null };
  history: Array<{ orderlyKey: string; prefix: string; revokedAt: number; reason: string }>;
  /** Live: contract accounts whose delegate signer Orderly confirmed (POST /v1/delegate_signer), lowercase -> ms. */
  delegates?: Record<string, number>;
}

export interface BuilderKeyFile {
  builder: StoredKey;
}

export function resolveKeysDir(dir = process.env.OPS_KEYS_DIR ?? ".data/keys"): string {
  return isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
}

function writeAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export async function newStoredKey(accountId: string, scope: string, ttlMs: number, now = Date.now()): Promise<{ stored: StoredKey; key: Ed25519Key }> {
  const key = await generateKey();
  return {
    key,
    stored: { accountId, orderlyKey: key.orderlyKey, secret: secretToString(key), scope, createdAt: now, expiration: now + ttlMs, registeredAt: null, revokedAt: null },
  };
}

export const toKey = (s: StoredKey): Promise<Ed25519Key> => keyFromSecret(s.secret);
export const prefixOf = (s: StoredKey): string => keyPrefix(s.orderlyKey);

export class KeyStore {
  constructor(readonly dir = resolveKeysDir()) {}

  bookPath(bookId: number) {
    return join(this.dir, `${bookId}.json`);
  }

  builderPath() {
    return join(this.dir, "builder.json");
  }

  loadBook(bookId: number): BookKeyFile | null {
    const p = this.bookPath(bookId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as BookKeyFile;
  }

  saveBook(f: BookKeyFile) {
    writeAtomic(this.bookPath(f.bookId), f);
  }

  loadBuilder(): BuilderKeyFile | null {
    const p = this.builderPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as BuilderKeyFile;
  }

  saveBuilder(f: BuilderKeyFile) {
    writeAtomic(this.builderPath(), f);
  }

  /** Ensure the book has a trade key (unless revoked) and ops keys for both accounts. */
  async ensureBook(bookId: number, accounts: { if: string; mm: string }, ttl: { tradeMs: number; opsMs: number }): Promise<BookKeyFile> {
    const f: BookKeyFile = this.loadBook(bookId) ?? { bookId, trade: null, ops: { if: null, mm: null }, history: [] };
    let changed = false;
    if (!f.trade || f.trade.accountId !== accounts.mm) {
      f.trade = (await newStoredKey(accounts.mm, TRADE_SCOPE, ttl.tradeMs)).stored;
      changed = true;
    }
    if (!f.ops.if || f.ops.if.accountId !== accounts.if) {
      f.ops.if = (await newStoredKey(accounts.if, OPS_SCOPE, ttl.opsMs)).stored;
      changed = true;
    }
    if (!f.ops.mm || f.ops.mm.accountId !== accounts.mm) {
      f.ops.mm = (await newStoredKey(accounts.mm, OPS_SCOPE, ttl.opsMs)).stored;
      changed = true;
    }
    if (changed) this.saveBook(f);
    return f;
  }

  /** Replace a revoked trade key with a fresh one (after a re-mandate). */
  async rotateTrade(bookId: number, ttlMs: number): Promise<BookKeyFile> {
    const f = this.loadBook(bookId);
    if (!f?.trade) throw new Error(`book ${bookId}: no trade key to rotate`);
    if (!f.trade.revokedAt) return f;
    f.trade = (await newStoredKey(f.trade.accountId, TRADE_SCOPE, ttlMs)).stored;
    this.saveBook(f);
    return f;
  }

  markRegistered(bookId: number, which: "trade" | "if" | "mm", at = Date.now()) {
    const f = this.loadBook(bookId);
    if (!f) return;
    const k = which === "trade" ? f.trade : f.ops[which];
    if (k && !k.registeredAt) {
      k.registeredAt = at;
      this.saveBook(f);
    }
  }

  delegateRegistered(bookId: number, delegateContract: string): boolean {
    return !!this.loadBook(bookId)?.delegates?.[delegateContract.toLowerCase()];
  }

  markDelegateRegistered(bookId: number, delegateContract: string, at = Date.now()) {
    const f = this.loadBook(bookId);
    if (!f) return;
    f.delegates = { ...(f.delegates ?? {}), [delegateContract.toLowerCase()]: at };
    this.saveBook(f);
  }

  markTradeRevoked(bookId: number, reason: string, at = Date.now()): StoredKey | null {
    const f = this.loadBook(bookId);
    if (!f?.trade) return null;
    if (!f.trade.revokedAt) {
      f.trade.revokedAt = at;
      f.trade.revokeReason = reason;
      f.history.push({ orderlyKey: f.trade.orderlyKey, prefix: prefixOf(f.trade), revokedAt: at, reason });
      this.saveBook(f);
    }
    return f.trade;
  }

  /** The book's active trade key (null if none or revoked) — what bookrunner agents quote with. */
  async tradeKey(bookId: number): Promise<{ key: Ed25519Key; accountId: string } | null> {
    const f = this.loadBook(bookId);
    if (!f?.trade || f.trade.revokedAt) return null;
    return { key: await toKey(f.trade), accountId: f.trade.accountId };
  }

  async opsKey(bookId: number, which: "if" | "mm"): Promise<Ed25519Key | null> {
    const k = this.loadBook(bookId)?.ops[which];
    return k ? toKey(k) : null;
  }

  /** Ops key (scope read,asset) for an Orderly account id, searching all book key files. */
  async opsKeyForAccount(accountId: string): Promise<Ed25519Key | null> {
    const want = accountId.toLowerCase();
    if (!existsSync(this.dir)) return null;
    for (const name of readdirSync(this.dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const f = this.loadBook(Number(name.slice(0, -5)));
      for (const k of [f?.ops.if, f?.ops.mm]) if (k && k.accountId.toLowerCase() === want) return toKey(k);
    }
    return null;
  }
}
