// Block-range planning (pure). Cursors store the last fully indexed block per contract group; both
// groups are processed over the same range so a BookCreated in the range can extend the watched
// set before the book components' logs for that range are fetched.

export interface Cursors {
  protocol: number | null;
  books: number | null;
}

export interface Range {
  from: bigint;
  to: bigint;
  /** last indexed block per group (logs at or below are already applied for that group) */
  done: { protocol: bigint; books: bigint };
}

export function planRange(cursors: Cursors, startBlock: number, head: bigint, confirmations: number, batch: number): Range | null {
  const floor = BigInt(Math.max(startBlock, 0)) - 1n;
  const protocol = cursors.protocol === null ? floor : BigInt(cursors.protocol);
  const books = cursors.books === null ? floor : BigInt(cursors.books);
  const safe = head - BigInt(confirmations);
  const from = (protocol < books ? protocol : books) + 1n;
  if (from > safe || from < 0n) return null;
  const end = from + BigInt(Math.max(batch, 1)) - 1n;
  return { from, to: end < safe ? end : safe, done: { protocol, books } };
}
