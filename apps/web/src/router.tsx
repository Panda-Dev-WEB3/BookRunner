import { Link, type RouteObject, createBrowserRouter, isRouteErrorResponse, useRouteError } from "react-router";
import { Layout, type RouteHandle } from "./components/Layout";
import { Container, EmptyState, PageHeader, SkeletonRows } from "./components/ui";
import { config } from "./lib/config";

function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  const message = String((err as Error)?.message ?? err);
  const staleChunk = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(message);
  return (
    <Container className="py-10">
      <PageHeader eyebrow={notFound ? "404" : "Error"} title={notFound ? "Page not found" : staleChunk ? "A newer version is available" : "This view failed to render"} />
      <EmptyState
        title={notFound ? "There is no page at this address." : staleChunk ? "This page's code changed since it was opened." : "An unexpected error stopped this page."}
        body={notFound ? undefined : staleChunk ? "Reload to fetch the current version." : message}
        action={
          staleChunk ? (
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : (
            <Link className="btn" to="/">
              Back to home
            </Link>
          )
        }
      />
    </Container>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader eyebrow="404" title="Page not found" />
      <EmptyState
        title="There is no page at this address."
        action={
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-primary" to="/">
              Back to home
            </Link>
            <Link className="btn" to="/books">
              All books
            </Link>
          </div>
        }
      />
    </>
  );
}

/** Investor pages lay out their own full-width Sections. */
const bleed: RouteHandle = { bleed: true };

const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: (
      <Container className="py-8">
        <SkeletonRows rows={6} />
      </Container>
    ),
    children: [
      // Route-level code splitting: every page loads on demand.
      // Investor pages
      { index: true, handle: bleed, lazy: async () => ({ Component: (await import("./pages/Home")).HomePage }) },
      { path: "learn", handle: bleed, lazy: async () => ({ Component: (await import("./pages/Learn")).LearnPage }) },
      { path: "invest", handle: bleed, lazy: async () => ({ Component: (await import("./pages/Invest")).InvestPage }) },
      { path: "portfolio", handle: bleed, lazy: async () => ({ Component: (await import("./pages/Portfolio")).PortfolioPage }) },
      { path: "stake", handle: bleed, lazy: async () => ({ Component: (await import("./pages/Stake")).StakePage }) },
      // Protocol (operator) pages
      { path: "books", lazy: async () => ({ Component: (await import("./pages/Books")).BooksPage }) },
      { path: "books/:bookId", lazy: async () => ({ Component: (await import("./pages/book/BookDetail")).BookDetailPage }) },
      { path: "charters", lazy: async () => ({ Component: (await import("./pages/Charters")).ChartersPage }) },
      { path: "charters/new", lazy: async () => ({ Component: (await import("./pages/FileCharter")).FileCharterPage }) },
      { path: "charters/:charterId", lazy: async () => ({ Component: (await import("./pages/CharterDetail")).CharterDetailPage }) },
      { path: "committee", lazy: async () => ({ Component: (await import("./pages/Committee")).CommitteePage }) },
      { path: "risk", lazy: async () => ({ Component: (await import("./pages/Risk")).RiskPage }) },
      { path: "agents", lazy: async () => ({ Component: (await import("./pages/Agents")).AgentsPage }) },
      { path: "*", element: <NotFound /> },
    ],
  },
];

// Deployed builds are mounted at /app/ (vite base "/app/"): every <Link to="/..."> and navigate() is
// resolved under this basename, so in-app paths stay written from "/". The dev server has none.
export const router = createBrowserRouter(routes, { basename: config.basename });
