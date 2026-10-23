// Prepared transactions are verified before the wallet is asked to sign (TxRunner), against contract
// addresses read from the CHAIN: every book's Book.components() (tranches, mandate; for an in-house book the
// PoolEngine its adapter names) and the protocol contracts its BookrunnerConfig names (the oracle among them) — never the addresses an API response carries. See
// @bookrunner/shared/preparedTx for the rules (known functions only, approvals only to a later step's
// contract for the amount it moves, the entered amount, the user's account as receiver).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type Address, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress } from "viem";
import { ADAPTER_ENGINE_ABI } from "../lib/abis";
import type { PreparedTx } from "../lib/api-types";
import { type FlowTargets, type TxCheck, checkTxs } from "../lib/txcheck";
import { appChain, publicClient } from "./chains";
import { useAppContracts, useInsurancePoolAddress } from "./contracts";
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
  const pool = useInsurancePoolAddress();
  const bookAddrs = useMemo(() => app.books.map((b) => ({ id: b.bookId, book: b.book, engine: b.venue === "pool_engine" })), [app.books]);
  const parts = useQuery({
    queryKey: ["book-parts", appChain.id, bookAddrs.map((b) => `${b.book}:${b.engine ? 1 : 0}`).join(",")],
    enabled: bookAddrs.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
    queryFn: () =>
      Promise.all(
        bookAddrs.map(async (b) => {
          const c = await publicClient.readContract({ address: b.book, abi: BOOK_COMPONENTS_ABI, functionName: "components" });
          // in-house book: the PoolEngine its adapter (from the book's own components) trades on
          // (an adapter without the getter, i.e. a venue label that does not match the chain: no engine target)
          const engine = b.engine
            ? await publicClient
                .readContract({ address: c.adapter, abi: ADAPTER_ENGINE_ABI, functionName: "engine" })
                .then((a) => getAddress(a))
                .catch((err: unknown) => {
                  // only an on-chain answer means "no engine"; a transport error fails the read (retried)
                  if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return null;
                  throw err;
                })
            : null;
          return { id: b.id, senior: getAddress(c.senior), junior: getAddress(c.junior), mandate: getAddress(c.mandate), engine };
        }),
      ),
  });
  const data = useMemo<FlowTargets | null>(() => {
    const p = app.data;
    // the pool read settles to an address or null (no pool on this deployment); wait for it either way
    if (!p || !parts.data || pool.data === undefined) return null;
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
    // 2026-10 insurance pool: requestDeposit / cancelDeposit / claimDeposit / requestWithdraw / claim (no decimals entry:
    // its share amounts have 12 decimals and its deposit amounts 6, the verifier formats each call itself)
    if (pool.data) add(pool.data, "Insurance pool");
    // trading page: the oracle relay before a margin withdrawal with an open position (AttestedOracle.update)
    add(p.oracle, "AttestedOracle");
    const engines = new Set<string>();
    for (const b of parts.data) {
      add(b.senior, `Senior tranche (book #${b.id})`, 6);
      add(b.junior, `Junior tranche (book #${b.id})`, 6);
      add(b.mandate, `MMMandate (book #${b.id})`);
      if (b.engine && !engines.has(b.engine)) {
        engines.add(b.engine);
        add(b.engine, "PoolEngine");
      }
    }
    return { targets, labels, decimals };
  }, [app.data, parts.data, pool.data, settlementSymbol]);
  return { data, error: app.error ?? parts.error ?? null };
}

/** checkTxs (lib/txcheck.ts) on this build's chain. */
export const checkAppTxs = (txs: readonly PreparedTx[], targets: FlowTargets | null, opts: { account?: string | null; amount?: bigint | null } = {}): TxCheck =>
  checkTxs(txs, targets, { ...opts, chainId: appChain.id });
