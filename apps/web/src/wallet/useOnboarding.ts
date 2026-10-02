// Live setup state for the active wallet (lib/onboarding.ts does the derivation).
import { type OnboardingState, deriveOnboarding } from "../lib/onboarding";
import { type WalletBalances, useWalletBalances } from "./balances";
import { appChain } from "./chains";
import { useWallet } from "./WalletContext";

export interface Onboarding extends OnboardingState {
  balances: WalletBalances;
}

/** Wallet -> network -> gas -> test USDC -> invest. Pass hasPosition when the page knows it. */
export function useOnboarding(opts: { hasPosition?: boolean } = {}): Onboarding {
  const w = useWallet();
  const balances = useWalletBalances();
  const state = deriveOnboarding({
    connected: w.active !== null,
    walletKind: w.active?.kind ?? null,
    walletChainId: w.active?.chainId ?? null,
    appChainId: appChain.id,
    ethWei: balances.eth,
    usdcRaw: balances.usdc,
    hasPosition: opts.hasPosition,
  });
  return { ...state, balances };
}
