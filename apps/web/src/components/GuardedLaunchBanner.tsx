// Guarded-launch banner (VITE_GUARDED_LAUNCH, mainnet builds): one thin line under the header saying the protocol is in
// its launch phase with no public market open, linking to the public site's official-links page. Dismissible for the
// browser session (sessionStorage); it comes back in a new session. useInvestGate: the deposit gate of the same phase.
import { useState } from "react";
import { POLL, trpc } from "../api/trpc";
import { GUARDED_LAUNCH } from "../lib/features";
import { BANNER_DISMISSED_KEY, GUARDED_COPY, type InvestGate, OFFICIAL_LINKS_URL, investGate } from "../lib/guardedLaunch";
import { safeSessionStorage } from "../lib/safeStorage";
import { IconClose, IconShield } from "./icons";
import { Container } from "./ui";

const session = safeSessionStorage();

export function GuardedLaunchBanner() {
  const [hidden, setHidden] = useState(() => session.getItem(BANNER_DISMISSED_KEY) === "1");
  if (!GUARDED_LAUNCH || hidden) return null;
  return (
    <div className="border-b border-accent/25 bg-accent-soft" role="region" aria-label="Launch notice">
      <Container className="flex items-center gap-2 py-1.5 text-[12.5px]">
        <IconShield size={15} className="shrink-0 text-accent-text" />
        <p className="min-w-0 flex-1 text-ink-2">
          <span className="font-semibold text-ink">{GUARDED_COPY.bannerLead}</span> {GUARDED_COPY.banner}{" "}
          <a href={OFFICIAL_LINKS_URL} className="link font-medium whitespace-nowrap">
            {GUARDED_COPY.bannerLink}
          </a>
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-icon size-7 shrink-0"
          aria-label={GUARDED_COPY.dismiss}
          title={GUARDED_COPY.dismiss}
          onClick={() => {
            session.setItem(BANNER_DISMISSED_KEY, "1");
            setHidden(true);
          }}
        >
          <IconClose size={14} />
        </button>
      </Container>
    </div>
  );
}

/** The deposit gate from the book list the app already loads (shared react-query cache with the Invest page). */
export function useInvestGate(): InvestGate {
  const list = trpc.book.list.useQuery(undefined, { enabled: GUARDED_LAUNCH, refetchInterval: POLL.slow, staleTime: 60_000 });
  return investGate(GUARDED_LAUNCH, list.data?.map((b) => b.state));
}
