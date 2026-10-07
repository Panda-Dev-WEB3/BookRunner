// Log-safe URLs: RPC providers put API keys in the query (?apikey=...) or the path (/v2/<key>), and
// DATABASE_URL / REDIS_URL carry passwords. Logs keep the scheme, host and port only.

/** "https://rpc.example.com/v2/abc...?key=x" -> "https://rpc.example.com/…" (unparseable -> "<redacted url>"). */
export function redactUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const hidden = u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash;
    return `${u.protocol}//${u.host}${hidden ? "/…" : ""}`;
  } catch {
    return "<redacted url>";
  }
}
