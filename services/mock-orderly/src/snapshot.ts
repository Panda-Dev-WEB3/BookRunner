// Optional JSON snapshot of the simulator state (default .data/mock-orderly.json). The snapshot is
// discarded when the deployment fingerprint (chain, vault, startBlock) changed — e.g. anvil reset.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MockVenue, VenueSnapshot } from "./venue";

export interface SnapshotFile {
  savedAt: number;
  fingerprint: string | null;
  cursor: string | null;
  venue: VenueSnapshot;
}

export function saveSnapshot(path: string, venue: MockVenue, fingerprint: string | null, cursor: bigint | null) {
  mkdirSync(dirname(path), { recursive: true });
  const body: SnapshotFile = { savedAt: Date.now(), fingerprint, cursor: cursor?.toString() ?? null, venue: venue.toSnapshot() };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, path);
  venue.dirty = false;
}

export type LoadResult = { loaded: true; cursor: bigint | null } | { loaded: false; reason: string };

export function loadSnapshot(path: string, venue: MockVenue, fingerprint: string | null): LoadResult {
  if (!existsSync(path)) return { loaded: false, reason: "no snapshot file" };
  const s = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
  if (s.fingerprint !== fingerprint) return { loaded: false, reason: `deployment fingerprint changed (${s.fingerprint} -> ${fingerprint})` };
  venue.loadSnapshot(s.venue);
  return { loaded: true, cursor: s.cursor ? BigInt(s.cursor) : null };
}
