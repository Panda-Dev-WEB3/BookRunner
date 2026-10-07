// Where the app is mounted. A deployed build lives under /app/ (the public site owns the web root); the
// dev server stays at /. Vite exposes the mount as import.meta.env.BASE_URL ("/" or "/app/"); these pure
// helpers turn it into react-router's basename and into shareable absolute links. The API is NOT under
// the mount: /trpc and /health stay at the host root (chainConfig.resolveApiUrl).

/** BASE_URL -> react-router basename: "/app/" -> "/app"; "/", "" or "./" -> undefined (mounted at the root). */
export function routerBasename(baseUrl: string | undefined): string | undefined {
  const b = (baseUrl ?? "").trim().replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (b === "") return undefined;
  return b.startsWith("/") ? b : `/${b}`;
}

/**
 * Absolute URL of an in-app path, for links that leave the router (copy-to-clipboard, share):
 * appUrl("https://x.com", "/app", "/learn#term-senior") -> "https://x.com/app/learn#term-senior".
 * Without an origin (no window) it returns the path under the mount.
 */
export function appUrl(origin: string | undefined, basename: string | undefined, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${(origin ?? "").replace(/\/+$/, "")}${basename ?? ""}${p}`;
}
