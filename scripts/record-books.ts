// Appends the books the chain knows (BookFactory.bookIds) but the deployment file does not list, so
// scripts/dev.ts starts one agent per book. Mainnet books are chartered on-chain by the sponsor (docs/RUNBOOK.md),
// never by launch-devnet.ts, so this is how they reach deployments/4663.json. Read-only on chain; writes the
// file only (operator command, outside the sandboxed stack whose deployment dir is read-only).
//   CHAIN_ID=4663 RPC_URL=$RHC_RPC_URL bun scripts/record-books.ts [--file contracts/deployments/4663.json] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { type Address, type Hex, zeroAddress } from "viem";
import { bookFactoryAbi, marketCharterAbi, stockTokenRegistryAbi } from "../packages/shared/src/abi";
import { bytes32ToStr, isTokenUnderlying, underlyingToToken } from "../packages/shared/src/bytes32";
import { publicClientFor } from "../packages/shared/src/clients";
import { deploymentPath } from "../packages/shared/src/deployments";
import type { BookComponents, Deployment } from "../packages/shared/src/types";

type Book = Deployment["books"][number];

/**
 * A book's display name: the ticker of its Stock Token underlying (deployment stockTokens), else the index's
 * oracle price id (e.g. RHX5), else `BOOK<id>`.
 */
export function bookName(dep: Pick<Deployment, "stockTokens">, bookId: number, underlying: Hex, indexPriceId: Hex | null): string {
  if (isTokenUnderlying(underlying)) {
    const token = underlyingToToken(underlying).toLowerCase();
    const hit = Object.entries(dep.stockTokens ?? {}).find(([, t]) => t.token.toLowerCase() === token);
    if (hit) return hit[0];
  } else if (indexPriceId && !/^0x0{64}$/.test(indexPriceId)) {
    return bytes32ToStr(indexPriceId);
  }
  return `BOOK${bookId}`;
}

/** The deployment with `fresh` appended (ids already listed are kept as they are). */
export function mergeBooks(dep: Deployment, fresh: Book[]): Deployment {
  const known = new Set(dep.books.map((b) => b.bookId));
  return { ...dep, books: [...dep.books, ...fresh.filter((b) => !known.has(b.bookId))].sort((a, b) => a.bookId - b.bookId) };
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const path = deploymentPath(fileIdx >= 0 ? args[fileIdx + 1] : process.env.DEPLOYMENT_FILE);
  const dep = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  const rpc = process.env.RPC_URL ?? process.env.RHC_RPC_URL;
  if (!rpc) throw new Error("set RPC_URL (or RHC_RPC_URL)");
  const pc = publicClientFor(dep.chainId, rpc);
  const c = dep.contracts;
  const ids = (await pc.readContract({ address: c.factory, abi: bookFactoryAbi, functionName: "bookIds" })) as readonly bigint[];
  const known = new Set(dep.books.map((b) => b.bookId));
  const fresh: Book[] = [];
  for (const id of ids) {
    if (known.has(Number(id))) continue;
    const components = (await pc.readContract({ address: c.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [id] })) as BookComponents;
    if (components.book === zeroAddress) continue;
    const rec = (await pc.readContract({ address: c.charter, abi: marketCharterAbi, functionName: "get", args: [id] })) as {
      charter: { underlying: Hex; venue: number; symbol: Hex };
    };
    const u = rec.charter.underlying;
    const indexPid = isTokenUnderlying(u)
      ? null
      : ((await pc.readContract({ address: c.stockRegistry as Address, abi: stockTokenRegistryAbi, functionName: "priceIdOf", args: [u] })) as Hex);
    fresh.push({
      bookId: Number(id),
      name: bookName(dep, Number(id), u, indexPid),
      symbol: bytes32ToStr(rec.charter.symbol),
      venue: rec.charter.venue as Book["venue"],
      components,
    });
  }
  if (fresh.length === 0) {
    console.log(`[record-books] ${path}: up to date (${dep.books.length} books)`);
    return;
  }
  for (const b of fresh) console.log(`[record-books] + book ${b.bookId} ${b.name} (${b.symbol}, venue ${b.venue}) ${b.components.book}`);
  if (args.includes("--dry-run")) return;
  writeFileSync(path, `${JSON.stringify(mergeBooks(dep, fresh), null, 2)}\n`);
  console.log(`[record-books] ${path}: ${fresh.length} book(s) appended — dev.ts starts their agents within seconds`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[record-books] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
