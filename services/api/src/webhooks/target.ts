// Webhook target policy (SSRF guard). Subscribers choose the URL the worker POSTs signed bodies to
// and can read back response codes / errors, so an unrestricted URL is a blind SSRF + port probe
// into the API host's network. Rules:
//   - http(s) only, no embedded credentials
//   - the host may not be (or resolve to) a loopback, private (RFC 1918 / ULA), link-local
//     (169.254/16 incl. cloud metadata, fe80::/10), CGNAT, unspecified, multicast or reserved address,
//     nor localhost / *.localhost / *.local / *.internal
//   - WEBHOOK_ALLOW_HOSTS (explicit dev allow-list of host names / IP literals) bypasses the
//     address rules for those hosts only.
// The URL is checked syntactically at create/patch time and its DNS answers again right before
// every delivery (a name can be re-pointed after creation). Redirects are never followed.
import { isIP } from "node:net";

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/** Comma/space separated host names or IP literals (case-insensitive; IPv6 with or without brackets). */
export function parseAllowHosts(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => normHost(s))
      .filter(Boolean),
  );
}

const normHost = (h: string) => h.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

function v4Parts(ip: string): number[] | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function blockedV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || // "this network" / unspecified
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0 && p[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // trailing embedded IPv4 (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = v4Parts(m[2]!);
    if (!v4) return null;
    s = `${m[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((w) => Number.parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

function blockedV6(ip: string): boolean {
  const w = expandV6(ip);
  if (!w) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
  const embeddedV4 = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0) {
    if (w5 === 0xffff) return blockedV4(embeddedV4); // IPv4-mapped
    if (w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) return true; // :: and ::1
    if (w5 === 0) return true; // deprecated IPv4-compatible
  }
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return blockedV4(embeddedV4); // NAT64
  if ((w0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((w0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((w0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((w0 & 0xff00) === 0xff00) return true; // multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return true; // documentation
  return false;
}

/** True for addresses a webhook must never reach (loopback, private, link-local, metadata, ...). */
export function isBlockedAddress(ip: string): boolean {
  const h = normHost(ip);
  const kind = isIP(h);
  if (kind === 4) return blockedV4(h);
  if (kind === 6) return blockedV6(h);
  return true; // not an IP literal: callers resolve names first
}

function blockedName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "";
}

/** Syntactic check of a subscription URL (create / patch). */
export function checkWebhookUrl(raw: string, allowHosts: ReadonlySet<string>): TargetCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "url must be an absolute http(s) URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "url must be an absolute http(s) URL" };
  if (u.username || u.password) return { ok: false, reason: "url must not embed credentials" };
  const host = normHost(u.hostname);
  if (allowHosts.has(host)) return { ok: true };
  if (isIP(host)) return isBlockedAddress(host) ? { ok: false, reason: `url points at a non-public address (${host})` } : { ok: true };
  if (blockedName(host)) return { ok: false, reason: `url points at a local host name (${host})` };
  return { ok: true };
}

export type ResolveHost = (host: string) => Promise<string[]>;

/** Delivery-time check: the URL again, then every DNS answer of its host. */
export async function checkResolvedTarget(raw: string, allowHosts: ReadonlySet<string>, resolve: ResolveHost): Promise<TargetCheck> {
  const syntactic = checkWebhookUrl(raw, allowHosts);
  if (!syntactic.ok) return syntactic;
  const host = normHost(new URL(raw).hostname);
  if (allowHosts.has(host) || isIP(host)) return { ok: true };
  const addrs = await resolve(host);
  if (addrs.length === 0) return { ok: false, reason: `url host ${host} did not resolve` };
  const bad = addrs.find((a) => !allowHosts.has(normHost(a)) && isBlockedAddress(a));
  return bad ? { ok: false, reason: `url host ${host} resolves to a non-public address (${bad})` } : { ok: true };
}

/** node:dns lookup of every A/AAAA answer. */
export const dnsResolveHost: ResolveHost = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};
