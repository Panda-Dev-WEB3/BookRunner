// Protocol parameters in copy, read live so the text never drifts from the chain: carry and the
// expense cap from BookrunnerConfig (timelock-settable), the mark cadence from the books' mark
// schedule. The launch defaults (learn/sim.ts PROTOCOL_DEFAULTS) stand in while a read is pending.
import { POLL, trpc } from "../api/trpc";
import { appChain } from "../wallet/chains";
import { pctOfBps } from "./invest/logic";
import { useProtocolParams } from "./invest/useInvestChain";
import { PROTOCOL_DEFAULTS } from "./learn/sim";

export interface ProtocolTerms {
  carryBps: number;
  expenseCapBps: number;
  /** "10%" */
  carry: string;
  /** "20%" */
  expenseCap: string;
  /** Read from BookrunnerConfig (false: still the launch defaults). */
  live: boolean;
}

/** Carry and expense cap as configured now, or the launch defaults while unknown. */
export function useProtocolTerms(): ProtocolTerms {
  const p = useProtocolParams();
  const carryBps = p.data?.carryBps ?? PROTOCOL_DEFAULTS.carryBps;
  const expenseCapBps = p.data?.expenseCapBps ?? PROTOCOL_DEFAULTS.expenseCapBps;
  return { carryBps, expenseCapBps, carry: pctOfBps(carryBps), expenseCap: pctOfBps(expenseCapBps), live: p.data?.carryBps != null };
}

/** The books' mark cadence ("hourly", "daily"), null while unknown. */
export function useMarkCadence(): string | null {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.slow, staleTime: 60_000 });
  return q.data?.[0]?.markSchedule.cadence ?? null;
}

/** "10%": the protocol carry, live. */
export function CarryPct() {
  return <>{useProtocolTerms().carry}</>;
}

/** "hourly on Robinhood Chain Testnet", or a neutral phrase before the schedule is known. */
export function MarkCadenceText() {
  const cadence = useMarkCadence();
  return <>{cadence ? `${cadence} on ${appChain.name}` : "at the interval each network sets"}</>;
}
