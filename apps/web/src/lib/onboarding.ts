// Setup checklist state (wallet -> network -> gas -> test USDC -> invest), derived from live wallet
// facts. Pure and DOM-free (test/onboarding.test.ts); <SetupChecklist/> renders it.
import { LOW_GAS_WEI } from "./chainConfig";

export type OnboardingStepId = "connect" | "network" | "gas" | "usdc" | "invest";
export type OnboardingStatus = "done" | "active" | "todo";

export const ONBOARDING_ORDER: readonly OnboardingStepId[] = ["connect", "network", "gas", "usdc", "invest"];

/** Gas needed before the checklist calls a wallet funded: 0.0005 ETH, enough for many testnet txs. */
export const MIN_GAS_WEI = LOW_GAS_WEI;

export interface OnboardingInput {
  connected: boolean;
  /** "dev" wallets (devnet only) sign on the app chain directly, so the network step is satisfied. */
  walletKind?: "dev" | "injected" | null;
  /** Chain the wallet is on (null while unknown). */
  walletChainId: number | null;
  appChainId: number;
  /** Native balance on the app chain; undefined while loading, null when unreadable. */
  ethWei: bigint | null | undefined;
  /** USDC balance (6 decimals); undefined while loading, null when unreadable. */
  usdcRaw: bigint | null | undefined;
  minGasWei?: bigint;
  /** Smallest USDC balance that counts (default: anything above zero). */
  minUsdcRaw?: bigint;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStatus;
  /** The value behind this step is still loading. */
  checking: boolean;
  /**
   * The value behind this step could not be read (an RPC failure): unknown, not "missing". The step
   * is not done, but nothing should tell the person to fund the wallet because of it.
   */
  unreadable: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  /** The step to act on next (null when every step is done). */
  current: OnboardingStepId | null;
  /** Wallet, network, gas and USDC are all in place: the wallet can invest. */
  ready: boolean;
  /** Some step is still loading or could not be read: do not call the wallet unfunded yet. */
  unsure: boolean;
  doneCount: number;
  total: number;
  /** 0..1 */
  progress: number;
}

export function deriveOnboarding(i: OnboardingInput): OnboardingState {
  const minGas = i.minGasWei ?? MIN_GAS_WEI;
  const minUsdc = i.minUsdcRaw ?? 1n;
  const connected = i.connected;
  const onChain = connected && (i.walletKind === "dev" || (i.walletChainId !== null && i.walletChainId === i.appChainId));
  const gasOk = connected && i.ethWei != null && i.ethWei >= minGas;
  const usdcOk = connected && i.usdcRaw != null && i.usdcRaw >= minUsdc;
  const ready = connected && onChain && gasOk && usdcOk;
  const done: Record<OnboardingStepId, boolean> = {
    connect: connected,
    network: onChain,
    gas: gasOk,
    usdc: usdcOk,
    invest: false,
  };
  const checking: Record<OnboardingStepId, boolean> = {
    connect: false,
    network: false,
    gas: connected && i.ethWei === undefined,
    usdc: connected && i.usdcRaw === undefined,
    invest: false,
  };
  const unreadable: Record<OnboardingStepId, boolean> = {
    connect: false,
    network: false,
    gas: connected && i.ethWei === null,
    usdc: connected && i.usdcRaw === null,
    invest: false,
  };
  let current: OnboardingStepId | null = null;
  const steps = ONBOARDING_ORDER.map((id): OnboardingStep => {
    if (done[id]) return { id, status: "done", checking: false, unreadable: false };
    // the invest step becomes actionable only once every prerequisite is in place
    const actionable = id !== "invest" || ready;
    if (current === null && actionable) {
      current = id;
      return { id, status: "active", checking: checking[id], unreadable: unreadable[id] };
    }
    return { id, status: "todo", checking: checking[id], unreadable: unreadable[id] };
  });
  const doneCount = steps.filter((s) => s.status === "done").length;
  const unsure = steps.some((s) => s.checking || s.unreadable);
  return { steps, current, ready, unsure, doneCount, total: steps.length, progress: doneCount / steps.length };
}
