// Site-wide banner under the header when a connected browser wallet is on another chain: one click
// switches (and adds Robinhood Chain Testnet when the wallet does not know it yet).
import { Container } from "../components/ui";
import { IconWarn } from "../components/icons";
import { appChain, chainName } from "./chains";
import { useWallet } from "./WalletContext";

export function WrongNetworkBanner() {
  const w = useWallet();
  if (!w.wrongNetwork || !w.active) return null;
  return (
    <div className="border-b border-warn/40 bg-warn/10" role="status">
      <Container className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-[13px]">
          <IconWarn size={17} className="mt-px shrink-0 text-warn-ink" />
          <span>
            Your wallet is on <span className="font-semibold">{chainName(w.active.chainId)}</span>. Bookrunner runs on{" "}
            <span className="font-semibold">{appChain.name}</span> (chain {appChain.id}); switch to sign transactions here.
          </span>
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
          <button type="button" className="btn btn-primary btn-sm" disabled={w.switching} onClick={() => void w.switchToAppChain()}>
            {w.switching ? "Check your wallet…" : `Switch to ${appChain.name}`}
          </button>
          <button type="button" className="btn btn-sm" disabled={w.switching} onClick={() => void w.addAppChain()}>
            Add network
          </button>
        </div>
      </Container>
      {w.networkError && (
        <Container className="pb-2 text-[12px] text-critical-ink">
          <span className="pl-6 sm:pl-0">{w.networkError}</span>
        </Container>
      )}
    </div>
  );
}
