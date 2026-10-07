import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type RouteObject, createPath, matchRoutes, resolvePath } from "react-router";
import { appUrl, routerBasename } from "../src/lib/basePath";
import { resolveApiUrl } from "../src/lib/chainConfig";
import { DEFAULT_BUILD_BASE, appBase } from "../scripts/base";

describe("vite base (scripts/base.ts)", () => {
  test("dev server at /, builds and preview under /app/", () => {
    expect(appBase(true)).toBe("/");
    expect(appBase(true, "/elsewhere/")).toBe("/");
    expect(appBase(false)).toBe("/app/");
    expect(DEFAULT_BUILD_BASE).toBe("/app/");
  });

  test("WEB_BASE overrides the build mount, normalised to /x/", () => {
    expect(appBase(false, "")).toBe("/app/");
    expect(appBase(false, "/")).toBe("/");
    expect(appBase(false, "ops")).toBe("/ops/");
    expect(appBase(false, "/ops")).toBe("/ops/");
    expect(appBase(false, "/a/b//")).toBe("/a/b/");
  });
});

describe("routerBasename", () => {
  test("BASE_URL -> react-router basename", () => {
    expect(routerBasename("/app/")).toBe("/app");
    expect(routerBasename("/app")).toBe("/app");
    expect(routerBasename("app/")).toBe("/app");
    expect(routerBasename("/a/b/")).toBe("/a/b");
  });

  test("mounted at the root: no basename", () => {
    expect(routerBasename("/")).toBeUndefined();
    expect(routerBasename("")).toBeUndefined();
    expect(routerBasename("./")).toBeUndefined();
    expect(routerBasename(undefined)).toBeUndefined();
  });

  test("react-router resolves /app/... URLs to the in-app routes", () => {
    const routes: RouteObject[] = [{ path: "/", children: [{ index: true }, { path: "learn" }, { path: "books/:bookId" }, { path: "*" }] }];
    const basename = routerBasename(appBase(false));
    const leaf = (url: string) => matchRoutes(routes, url, basename)?.at(-1);
    expect(leaf("/app/books/7")?.params).toEqual({ bookId: "7" });
    expect(leaf("/app/books/7")?.route.path).toBe("books/:bookId");
    expect(leaf("/app/learn")?.route.path).toBe("learn");
    expect(leaf("/app/")?.route.index).toBe(true);
    expect(leaf("/app")?.route.index).toBe(true);
    // the public site's pages are not the app's
    expect(matchRoutes(routes, "/research/", basename)).toBeNull();
    expect(matchRoutes(routes, "/learn", basename)).toBeNull();
  });

  test("in-app paths stay written from / (the router prefixes the basename)", () => {
    const to = resolvePath("/learn#tranches");
    expect(createPath(to)).toBe("/learn#tranches");
  });
});

describe("appUrl (links that leave the router)", () => {
  test("shareable glossary links point under the mount", () => {
    expect(appUrl("https://bookrunner.use-cert.com", "/app", "/learn#term-senior")).toBe("https://bookrunner.use-cert.com/app/learn#term-senior");
    expect(appUrl("https://bookrunner.use-cert.com/", "/app", "learn")).toBe("https://bookrunner.use-cert.com/app/learn");
  });

  test("dev server (no basename) and no window", () => {
    expect(appUrl("http://127.0.0.1:5180", undefined, "/learn#x")).toBe("http://127.0.0.1:5180/learn#x");
    expect(appUrl(undefined, "/app", "/learn#x")).toBe("/app/learn#x");
    expect(appUrl(undefined, undefined, "/learn#x")).toBe("/learn#x");
  });
});

describe("the API stays at the host root", () => {
  test("same-origin resolves to the origin, never under /app", () => {
    // location.origin never carries the path; a page at /app/books/7 still calls {origin}/trpc
    const origin = new URL("https://bookrunner.use-cert.com/app/books/7").origin;
    expect(resolveApiUrl("same-origin", origin)).toBe("https://bookrunner.use-cert.com");
    expect(`${resolveApiUrl("same-origin", origin)}/trpc`).toBe("https://bookrunner.use-cert.com/trpc");
  });
});

describe("nginx serves the build where vite mounts it", () => {
  const conf = readFileSync(new URL("../../../deploy/server/nginx-bookrunner-locations.conf", import.meta.url), "utf8");
  test("the SPA fallback and hashed assets live under the build base", () => {
    expect(conf).toContain(`location ${DEFAULT_BUILD_BASE} {`);
    expect(conf).toContain(`${DEFAULT_BUILD_BASE}index.html;`);
    expect(conf).toContain(`location ^~ ${DEFAULT_BUILD_BASE}assets/ {`);
  });
  test("the API proxies stay at the root", () => {
    expect(conf).toContain("location = /health {");
    expect(conf).toContain("location ^~ /trpc/ {");
  });
});
