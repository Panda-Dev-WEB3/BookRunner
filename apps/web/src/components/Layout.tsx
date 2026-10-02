import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useHealth } from "../api/hooks";
import { config } from "../lib/config";
import { LEGAL, STRAPLINE, TAGLINE } from "../lib/copy";
import { appChain, chainName } from "../wallet/chains";
import { WalletButton } from "../wallet/WalletButton";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Books", end: true },
  { to: "/charters", label: "Charters" },
  { to: "/committee", label: "Committee" },
  { to: "/risk", label: "Risk" },
  { to: "/agents", label: "Agents" },
];

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("bkrn.theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem("bkrn.theme");
      else localStorage.setItem("bkrn.theme", theme);
    } catch {
      // storage blocked: theme lasts for this page only
    }
  }, [theme]);
  const next = () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));
  return [theme, next];
}

function ThemeToggle() {
  const [theme, next] = useTheme();
  const label = theme === "system" ? "Theme: system" : theme === "light" ? "Theme: light" : "Theme: dark";
  return (
    <button type="button" className="btn btn-ghost h-8 min-h-8 w-8 px-0" onClick={next} title={label} aria-label={label}>
      {theme === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" fill="currentColor" />
        </svg>
      ) : theme === "light" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

function ApiStatus() {
  const h = useHealth();
  const up = h.data?.ok === true;
  const tone = h.isLoading ? "bg-muted" : up ? (h.data?.deployment ? "bg-good" : "bg-warn") : "bg-critical";
  const text = h.isLoading ? "Connecting" : up ? (h.data?.deployment ? chainName(h.data.chainId) : "Not deployed") : "API offline";
  const title = up
    ? h.data?.deployment
      ? `API ${config.apiUrl} · contracts deployed on ${chainName(h.data.chainId)}`
      : `API ${config.apiUrl} is up; contracts are not deployed yet, on-chain actions are unavailable`
    : `No answer from ${config.apiUrl}/health`;
  return (
    <span className="hidden items-center gap-1.5 rounded-[2px] border border-line px-2 py-1 text-[11px] text-ink-2 md:inline-flex" title={title}>
      <span className={cx("size-1.5 rounded-full", tone)} aria-hidden />
      <span className="num">{text}</span>
    </span>
  );
}

/** The API answers for another chain than this build targets: prepared txs would not match. */
function ChainMismatch() {
  const h = useHealth();
  const apiChain = h.data?.chainId ?? null;
  if (apiChain === null || apiChain === appChain.id) return null;
  return (
    <div className="border-b border-warn/50 bg-warn/10" role="status">
      <div className="mx-auto max-w-[1440px] px-4 py-2 text-[12px] md:px-6">
        The API at <span className="num">{config.apiUrl}</span> serves {chainName(apiChain)} (chain {apiChain}); this build runs on {appChain.name} (chain {appChain.id}). Reads still work;
        prepared transactions are disabled until both point at the same chain (VITE_CHAIN_ID, VITE_API_URL).
      </div>
    </div>
  );
}

export function Layout() {
  const loc = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-3 px-4 md:px-6">
          <NavLink to="/" className="flex min-w-0 items-baseline gap-3" aria-label="Bookrunner home">
            <span className="text-[15px] font-bold tracking-[0.16em]">BOOKRUNNER</span>
            <span className="hidden h-4 w-px self-center bg-line-strong sm:block" aria-hidden />
            <span className="hidden truncate text-[12.5px] text-ink-2 sm:block">{TAGLINE}</span>
          </NavLink>
          <div className="flex items-center gap-2">
            <ApiStatus />
            <ThemeToggle />
            <WalletButton compact />
          </div>
        </div>
        <nav className="mx-auto max-w-[1440px] px-4 md:px-6" aria-label="Primary">
          <ul className="scroll-x no-scrollbar -mb-px flex gap-5">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    cx(
                      "inline-flex h-9 items-center border-b-2 text-[12px] font-semibold tracking-[0.06em] uppercase whitespace-nowrap",
                      isActive ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
                    )
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <ChainMismatch />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-5 md:px-6 md:py-6">
        <Outlet />
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-5 text-[11.5px] text-ink-2 md:flex-row md:items-start md:justify-between md:px-6">
          <div className="max-w-3xl">
            <div className="font-semibold tracking-[0.14em] text-ink">BOOKRUNNER</div>
            <p className="mt-1">{STRAPLINE}</p>
            <p className="mt-2 text-muted">{LEGAL}</p>
          </div>
          <div className="num text-muted md:text-right">
            <div>API {config.apiUrl}</div>
            <div>
              {appChain.name} · chain {appChain.id}
            </div>
            <div>RPC {config.rpcUrl}</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
