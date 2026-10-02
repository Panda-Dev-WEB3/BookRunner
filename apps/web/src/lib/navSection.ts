// Which header section a location belongs to (pure; test/nav-section.test.ts). A book page reached
// from Invest ("Invest in NVDA", "Choose Junior": #invest, ?tranche=, ?tab=withdraw) is part of the
// investor flow, so Invest stays highlighted instead of the operator "Protocol" menu.

const PROTOCOL_PREFIXES = ["/books", "/charters", "/committee", "/risk", "/agents"];

export type NavSection = "invest" | "protocol" | null;

export function navSection(pathname: string, search = "", hash = ""): NavSection {
  if (pathname === "/invest" || pathname.startsWith("/invest/")) return "invest";
  if (/^\/books\/[^/]+\/?$/.test(pathname)) {
    const q = new URLSearchParams(search);
    if (hash === "#invest" || q.has("tranche") || q.get("tab") === "withdraw") return "invest";
  }
  return PROTOCOL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? "protocol" : null;
}
