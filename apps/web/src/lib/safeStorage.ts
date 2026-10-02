// Browser storage that never throws. Chrome's window.localStorage GETTER throws SecurityError when
// the browser blocks site data, and wagmi's default storage reads it unguarded at createConfig time
// (module scope), which used to leave the whole app blank. Pure (unit-tested in
// test/safe-storage.test.ts): falls back to memory, so choices simply are not remembered.

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage for the session (lost on reload). */
export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

type WindowLike = { localStorage?: KeyValueStorage | null };

/**
 * window.localStorage behind try/catch: reading the property, and every call. When the property
 * throws or is missing, an in-memory store stands in; when one call throws (quota, a blocked write),
 * that call falls back to memory too.
 */
export function safeLocalStorage(win: WindowLike | undefined = (globalThis as { window?: WindowLike }).window): KeyValueStorage {
  const memory = memoryStorage();
  let ls: KeyValueStorage | null = null;
  try {
    ls = win?.localStorage ?? null;
  } catch {
    ls = null;
  }
  if (!ls) return memory;
  const s = ls;
  return {
    getItem(k) {
      try {
        return s.getItem(k) ?? memory.getItem(k);
      } catch {
        return memory.getItem(k);
      }
    },
    setItem(k, v) {
      try {
        s.setItem(k, v);
      } catch {
        memory.setItem(k, v);
      }
    },
    removeItem(k) {
      try {
        s.removeItem(k);
      } catch {
        // blocked: nothing stored there to remove
      }
      memory.removeItem(k);
    },
  };
}
