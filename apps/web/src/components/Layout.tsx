// App shell: sticky header (investor nav + "Protocol" menu for the operator pages, API status,
// theme, wallet), mobile drawer, wrong-network banner, footer. Routes with handle.bleed render
// full-width (investor pages build their own Sections); every other route gets the page container.
import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatches } from "react-router";
import { useHealth } from "../api/hooks";
import { config } from "../lib/config";
import { LEGAL, STRAPLINE } from "../lib/copy";
import { appChain, chainName } from "../wallet/chains";
import { isTestChain } from "../wallet/network";
import { WalletButton } from "../wallet/WalletButton";
import { WrongNetworkBanner } from "../wallet/WrongNetworkBanner";
import { cx } from "./cx";
import { IconChevronDown, IconExternal, IconGithub, IconMenu, LogoMark } from "./icons";
import { Container, Drawer } from "./ui";

export interface RouteHandle {
  /** Render without the page container (the page lays out its own full-width Sections). */
  bleed?: boolean;
}

export const PRIMARY_NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/invest", label: "Invest" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/stake", label: "Stake" },
  { to: "/learn", label: "How it works" },
] as const;

export const PROTOCOL_NAV = [
  { to: "/books", label: "Books", hint: "Every book: NAV, limits, marks" },
  { to: "/charters", label: "Charters", hint: "Filed markets and decisions" },
  { to: "/charters/new", label: "File a charter", hint: "Sponsor a new market" },
  { to: "/committee", label: "Committee", hint: "Risk Committee votes" },
  { to: "/risk", label: "Risk", hint: "Limit states and kill log" },
  { to: "/agents", label: "Agents", hint: "Desk keys and bonds" },
] as const;

const PROTOCOL_PREFIXES = ["/books", "/charters", "/committee", "/risk", "/agents"];

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

function ThemeToggle({ className }: { className?: string }) {
  const [theme, next] = useTheme();
  const label = theme === "system" ? "Theme: system (switch to light)" : theme === "light" ? "Theme: light (switch to dark)" : "Theme: dark (switch to system)";
  return (
    <button type="button" className={cx("btn btn-ghost btn-icon", className)} onClick={next} title={label} aria-label={label}>
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" fill="currentColor" />
        </svg>
      ) : theme === "light" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

function ApiStatus({ className }: { className?: string }) {
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
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-2", className)} title={title}>
      <span className={cx("size-1.5 rounded-full", tone)} aria-hidden />
      <span className="sr-only">API status: </span>
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
      <Container className="py-2 text-[12.5px]">
        The API at <span className="num">{config.apiUrl}</span> serves {chainName(apiChain)} (chain {apiChain}); this build runs on {appChain.name} (chain {appChain.id}). Reads still work;
        prepared transactions are disabled until both point at the same chain (VITE_CHAIN_ID, VITE_API_URL).
      </Container>
    </div>
  );
}

const navLinkCls = ({ isActive }: { isActive: boolean }) =>
  cx(
    "inline-flex h-9 items-center rounded-control px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors",
    isActive ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink",
  );

function ProtocolMenu() {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const active = PROTOCOL_PREFIXES.some((p) => loc.pathname === p || loc.pathname.startsWith(`${p}/`));

  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className={cx(navLinkCls({ isActive: active }), "gap-1")}
      >
        Protocol
        <IconChevronDown size={14} className={cx("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div id={menuId} className="pop-in absolute top-full left-0 z-50 mt-2 w-[300px] rounded-card border border-line bg-surface p-2 shadow-pop">
          <p className="px-2.5 pt-1.5 pb-2 text-[12px] text-muted">Operator views of the live protocol.</p>
          <ul>
            {PROTOCOL_NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.to === "/charters"}
                  className={({ isActive }) => cx("block rounded-control px-2.5 py-2 transition-colors hover:bg-surface-2", isActive && "bg-surface-2")}
                >
                  <span className="block text-[13.5px] font-medium text-ink">{n.label}</span>
                  <span className="block text-[12px] text-muted">{n.hint}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const item = ({ isActive }: { isActive: boolean }) =>
    cx("flex h-11 items-center rounded-control px-3 text-[15px] font-medium", isActive ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink");
  return (
    <Drawer open={open} onClose={onClose} title="Menu">
      <nav aria-label="Mobile" className="space-y-6 p-3">
        <ul className="space-y-0.5">
          {PRIMARY_NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={"end" in n ? n.end : undefined} className={item} onClick={onClose}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div>
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Protocol</div>
          <ul className="space-y-0.5">
            {PROTOCOL_NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === "/charters"} className={item} onClick={onClose}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 pt-4">
          <ApiStatus />
          <ThemeToggle />
        </div>
      </nav>
    </Drawer>
  );
}

function Header() {
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [loc.pathname]);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur-md supports-[backdrop-filter]:bg-surface/75">
      <Container className="flex h-16 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-6">
          <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-control" aria-label="Bookrunner home">
            <LogoMark size={30} />
            <span className="text-[16px] font-bold tracking-[-0.01em]">Bookrunner</span>
          </Link>
          <nav aria-label="Primary" className="hidden lg:block">
            <ul className="flex items-center gap-0.5">
              {PRIMARY_NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={"end" in n ? n.end : undefined} className={navLinkCls}>
                    {n.label}
                  </NavLink>
                </li>
              ))}
              <li>
                <ProtocolMenu />
              </li>
            </ul>
          </nav>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="hidden xl:inline-flex">
            <ApiStatus />
          </span>
          <ThemeToggle className="hidden sm:inline-flex" />
          <WalletButton compact />
          <button type="button" className="btn btn-ghost btn-icon lg:hidden" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <IconMenu size={20} />
          </button>
        </div>
      </Container>
      <MobileNav open={drawer} onClose={() => setDrawer(false)} />
    </header>
  );
}

function FooterLinks({ title, links }: { title: string; links: Array<{ label: string; to?: string; href?: string }> }) {
  return (
    <div>
      <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink uppercase">{title}</h2>
      <ul className="mt-3 space-y-2 text-[13px]">
        {links.map((l) => (
          <li key={l.label}>
            {l.to ? (
              <Link to={l.to} className="text-ink-2 hover:text-ink">
                {l.label}
              </Link>
            ) : (
              <a href={l.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
                {l.label}
                <IconExternal size={12} className="opacity-60" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footer() {
  const resources = [
    { label: "Docs", href: config.docsUrl },
    { label: "GitHub", href: config.repoUrl },
    ...(config.explorerUrl ? [{ label: "Block explorer", href: config.explorerUrl }] : []),
    ...(config.faucetUrl ? [{ label: "Gas faucet", href: config.faucetUrl }] : []),
  ];
  return (
    <footer className="mt-8 border-t border-line bg-surface">
      {isTestChain && (
        <div className="border-b border-line bg-warn/[0.07]">
          <Container className="flex flex-col gap-1 py-3 text-[12.5px] text-ink-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-warn/20 px-2 py-0.5 text-[11px] font-semibold tracking-[0.06em] text-warn-ink uppercase">
              {config.chain.kind === "devnet" ? "Devnet" : "Testnet"}
            </span>
            <span>
              Bookrunner runs on {appChain.name}. Test USDC and testnet ETH have no value, and the contracts are experimental software: nothing on this site is an offer or advice.
            </span>
          </Container>
        </div>
      )}
      <Container className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <Link to="/" className="inline-flex items-center gap-2.5" aria-label="Bookrunner home">
            <LogoMark size={26} />
            <span className="text-[15px] font-bold">Bookrunner</span>
          </Link>
          <p className="mt-3 text-[13px] text-ink-2">{STRAPLINE}</p>
          <a href={config.repoUrl} target="_blank" rel="noreferrer noopener" className="mt-4 inline-flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink">
            <IconGithub size={16} />
            Source on GitHub
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <FooterLinks
          title="Invest"
          links={[
            { label: "Invest", to: "/invest" },
            { label: "Portfolio", to: "/portfolio" },
            { label: "Stake BKRN", to: "/stake" },
            { label: "How it works", to: "/learn" },
          ]}
        />
        <FooterLinks title="Protocol" links={PROTOCOL_NAV.map((n) => ({ label: n.label, to: n.to }))} />
        <FooterLinks title="Resources" links={resources} />
      </Container>
      <div className="border-t border-line">
        <Container className="flex flex-col gap-3 py-5 text-[12px] text-muted md:flex-row md:items-start md:justify-between">
          <p className="max-w-3xl">{LEGAL}</p>
          <div className="num flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 md:justify-end">
            <ApiStatus />
            <span>
              {appChain.name} · chain {appChain.id}
            </span>
          </div>
        </Container>
      </div>
    </footer>
  );
}

export function Layout() {
  const loc = useLocation();
  const matches = useMatches();
  const bleed = matches.some((m) => (m.handle as RouteHandle | undefined)?.bleed === true);
  useEffect(() => {
    if (!loc.hash) {
      window.scrollTo({ top: 0 });
      return;
    }
    // #anchors (e.g. /learn#term-senior): the target may render after a lazy route loads, so retry
    // briefly. Content above it can still grow once its queries settle (e.g. /stake#where-it-comes-from
    // on a phone), so keep the target aligned for a short while unless the person scrolls first.
    const id = decodeURIComponent(loc.hash.slice(1));
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | undefined;
    let stop: ReturnType<typeof setTimeout> | undefined;
    let keep: ReturnType<typeof setInterval> | undefined;
    let moved = false;
    const onMove = () => {
      moved = true;
      release();
    };
    const userEvents = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    function release() {
      clearInterval(keep);
      keep = undefined;
      for (const e of userEvents) window.removeEventListener(e, onMove);
    }
    // re-scroll when the target drifted from its scroll-margin line (content above it, or a banner
    // above <main>, grew after the jump)
    const align = () => {
      const el = document.getElementById(id);
      if (!el || moved) return;
      const want = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (Math.abs(el.getBoundingClientRect().top - want) > 4) el.scrollIntoView({ block: "start" });
    };
    const go = () => {
      const el = document.getElementById(id);
      if (!el) {
        if (tries++ < 20) t = setTimeout(go, 100);
        return;
      }
      el.scrollIntoView({ block: "start" });
      for (const e of userEvents) window.addEventListener(e, onMove, { passive: true });
      keep = setInterval(align, 150);
      stop = setTimeout(release, 4_000);
    };
    go();
    return () => {
      clearTimeout(t);
      clearTimeout(stop);
      release();
    };
  }, [loc.pathname, loc.hash]);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:shadow-pop"
      >
        Skip to content
      </a>
      <Header />
      <WrongNetworkBanner />
      <ChainMismatch />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {bleed ? (
          <Outlet />
        ) : (
          <Container className="py-6 sm:py-8">
            <Outlet />
          </Container>
        )}
      </main>
      <Footer />
    </div>
  );
}
