// The public URL path the web app is mounted at (Vite `base`). Deployed builds live under /app/ next to the
// public site at the web root (deploy/server/nginx-bookrunner-locations.conf); the `vite` dev server serves at /.

/** Where builds (and `vite preview` of them) are mounted unless WEB_BASE says otherwise. */
export const DEFAULT_BUILD_BASE = "/app/";

/** Vite `base`: "/" for the dev server, else WEB_BASE (normalised to "/x/") or /app/. */
export function appBase(devServer: boolean, override?: string): string {
  if (devServer) return "/";
  const raw = (override ?? "").trim();
  if (raw === "") return DEFAULT_BUILD_BASE;
  const inner = raw.replace(/^\/+|\/+$/g, "");
  return inner === "" ? "/" : `/${inner}/`;
}
