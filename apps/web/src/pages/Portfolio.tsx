// Portfolio (/portfolio): the connected wallet's Senior and Junior shares in every book at the latest
// marks, deposits waiting for a mark, redemption requests, claims, BKRN staking and recent activity.
// Without a wallet: what the page shows and the setup checklist.
import { ConnectPrompt } from "../components/portfolio/ConnectPrompt";
import { PortfolioDashboard } from "../components/portfolio/PortfolioDashboard";
import { useWallet } from "../wallet/WalletContext";

export function PortfolioPage() {
  const w = useWallet();
  const address = w.active?.address ?? null;
  // keyed by address: switching wallets resets dialogs and in-flight claims
  return address ? <PortfolioDashboard key={address} wallet={address} /> : <ConnectPrompt />;
}
