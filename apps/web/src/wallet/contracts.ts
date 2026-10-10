// Protocol contract addresses for the browser. The API's book.list carries every book's components;
// the protocol-wide addresses (USDC, BKRN, staking, fee router, backstop, ...) are read once from the
// BookrunnerConfig a book points at (Book.config()). VITE_USDC_ADDRESS, when set, overrides USDC.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { type Address, getAddress } from "viem";
import { trpc } from "../api/trpc";
import { BOOK_CONFIG_ABI, CONFIG_ADDRESSES_ABI } from "../lib/abis";
import type { BookListItem } from "../lib/api-types";
import { config } from "../lib/config";
import { getSettlementSymbol, subscribeSettlementSymbol } from "../lib/settlementToken";
import { appChain, publicClient } from "./chains";

export interface BookContracts {
  bookId: number;
  symbol: string;
  name: string | null;
  venue: BookListItem["venue"];
  book: Address;
  senior: Address;
  junior: Address;
  vault: Address;
  mandate: Address;
  router: Address;
  desk: Address;
  adapter: Address;
}

export interface ProtocolContracts {
  config: Address;
  usdc: Address;
  bkrn: Address;
  staking: Address;
  feeRouter: Address;
  backstop: Address;
  markRegistry: Address;
  oracle: Address;
  charter: Address;
  committee: Address;
  factory: Address;
}

export interface AppContracts extends ProtocolContracts {
  chainId: number;
  books: BookContracts[];
}

export interface AppContractsResult {
  /** undefined until the protocol addresses are known. */
  data: AppContracts | undefined;
  /** Book components only (available as soon as book.list answers, even before chain reads). */
  books: BookContracts[];
  isLoading: boolean;
  error: unknown;
  /** The API answered with no books yet (protocol addresses cannot be resolved). */
  noBooks: boolean;
  refetch: () => void;
}

const PROTOCOL_KEYS = ["usdc", "bkrn", "staking", "feeRouter", "backstop", "markRegistry", "oracle", "charter", "committee", "factory"] as const;

export const toBookContracts = (b: BookListItem): BookContracts => ({
  bookId: b.bookId,
  symbol: b.symbol,
  name: b.name,
  venue: b.venue,
  book: getAddress(b.components.book),
  senior: getAddress(b.components.senior),
  junior: getAddress(b.components.junior),
  vault: getAddress(b.components.vault),
  mandate: getAddress(b.components.mandate),
  router: getAddress(b.components.router),
  desk: getAddress(b.components.desk),
  adapter: getAddress(b.components.adapter),
});

async function readProtocol(book: Address): Promise<ProtocolContracts> {
  const cfg = await publicClient.readContract({ address: book, abi: BOOK_CONFIG_ABI, functionName: "config" });
  const values = await Promise.all(PROTOCOL_KEYS.map((k) => publicClient.readContract({ address: cfg, abi: CONFIG_ADDRESSES_ABI, functionName: k })));
  const out = { config: getAddress(cfg) } as ProtocolContracts;
  PROTOCOL_KEYS.forEach((k, i) => {
    const v = values[i];
    if (!v) throw new Error(`BookrunnerConfig.${k}() returned nothing`);
    out[k] = getAddress(v);
  });
  if (config.usdcAddress) out.usdc = getAddress(config.usdcAddress);
  return out;
}

/** Every address the investor pages need, resolved through the API's book list + one config read. */
export function useAppContracts(): AppContractsResult {
  // every page that reads the protocol also shows settlement-token amounts: re-render it when the
  // token's symbol() arrives (wallet/settlementSymbol.ts), so pure formatters pick the new label up
  useSyncExternalStore(subscribeSettlementSymbol, getSettlementSymbol, getSettlementSymbol);
  const list = trpc.book.list.useQuery(undefined, { staleTime: 60_000 });
  const books = useMemo(() => (list.data ?? []).map(toBookContracts), [list.data]);
  const first = books[0]?.book ?? null;
  const q = useQuery({
    queryKey: ["app-contracts", appChain.id, first],
    enabled: first !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
    queryFn: () => readProtocol(first as Address),
  });
  const data = useMemo<AppContracts | undefined>(() => (q.data ? { ...q.data, chainId: appChain.id, books } : undefined), [q.data, books]);
  return {
    data,
    books,
    isLoading: list.isLoading || (first !== null && q.isLoading),
    error: list.error ?? q.error ?? null,
    noBooks: list.data !== undefined && list.data.length === 0,
    refetch: () => {
      void list.refetch();
      void q.refetch();
    },
  };
}
