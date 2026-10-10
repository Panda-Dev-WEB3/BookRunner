// Prepared transactions are verified before the wallet is asked to sign (TxRunner), against contract
// addresses read from the CHAIN: every book's Book.components() (tranches, mandate) and the protocol
// contracts its BookrunnerConfig names — never the addresses an API response carries. See
// @bookrunner/shared/preparedTx for the rules (known functions only, approvals only to a later step's
// contract for the amount it moves, the entered amount, the user's account as receiver).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type Address, getAddress } from "viem";
import type { PreparedTx } from "../lib/api-types";
import { type FlowTargets, type TxCheck, checkTxs } from "../lib/txcheck";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";
import { useSettlementSymbol } from "./settlementSymbol";

const BOOK_COMPONENTS_ABI = [
  {
    type: "function",
    name: "components",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "book", type: "address" },
          { name: "senior", type: "address" },
          { name: "junior", type: "address" },
          { name: "vault", type: "address" },
          { name: "mandate", type: "address" },
          { name: "router", type: "address" },
          { name: "desk", type: "address" },
          { name: "adapter", type: "address" },
        ],
      },
    ],
  },
] as const;

export type { FlowTargets, TxCheck };

/** Contracts a prepared step may call, from the chain (null while loading or when the reads failed). */
export function useFlowTargets(): { data: FlowTargets | null; error: unknown } {
  const app = useAppContracts();
  const settlementSymbol = useSettlementSymbol();
  const bookAddrs = useMemo(() => app.books.map((b) => ({ id: b.bookId, book: b.book })), [app.books]);
  const parts = useQuery({
    queryKey: ["book-parts", appChain.id, bookAddrs.map((b) => b.book).join(",")],
    enabled: bookAddrs.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
    queryFn: () =>
      Promise.all(
        bookAddrs.map(async (b) => {
          const c = await publicClient.readContract({ address: b.book, abi: BOOK_COMPONENTS_ABI, functionName: "components" });
          return { id: b.id, senior: getAddress(c.senior), junior: getAddress(c.junior), mandate: getAddress(c.mandate) };
        }),
      ),
  });
  const data = useMemo<FlowTargets | null>(() => {
    const p = app.data;
    if (!p || !parts.data) return null;
    const targets: string[] = [];
    const labels: Record<string, string> = {};
    const decimals: Record<string, number> = {};
    const add = (a: Address, label: string, dec?: number) => {
      targets.push(a);
      labels[a] = label;
      if (dec !== undefined) decimals[a] = dec;
    };
    add(p.usdc, settlementSymbol, 6);
    add(p.bkrn, "BKRN", 18);
    add(p.staking, "BKRN staking", 18);
    add(p.charter, "MarketCharter");
    add(p.committee, "RiskCommittee");
    for (const b of parts.data) {
      add(b.senior, `Senior tranche (book #${b.id})`, 6);
      add(b.junior, `Junior tranche (book #${b.id})`, 6);
      add(b.mandate, `MMMandate (book #${b.id})`);
    }
    return { targets, labels, decimals };
  }, [app.data, parts.data, settlementSymbol]);
  return { data, error: app.error ?? parts.error ?? null };
}

/** checkTxs (lib/txcheck.ts) on this build's chain. */
export const checkAppTxs = (txs: readonly PreparedTx[], targets: FlowTargets | null, opts: { account?: string | null; amount?: bigint | null } = {}): TxCheck =>
  checkTxs(txs, targets, { ...opts, chainId: appChain.id });
