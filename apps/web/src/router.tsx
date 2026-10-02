import { Link, createBrowserRouter, isRouteErrorResponse, useRouteError } from "react-router";
import { Layout } from "./components/Layout";
import { EmptyState, PageHeader, SkeletonRows } from "./components/ui";
import { BooksPage } from "./pages/Books";

function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  const message = String((err as Error)?.message ?? err);
  const staleChunk = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(message);
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6">
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
              Back to books
            </Link>
          )
        }
      />
    </div>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader eyebrow="404" title="Page not found" />
      <EmptyState
        title="There is no page at this address."
        action={
          <Link className="btn" to="/">
            Back to books
          </Link>
        }
      />
    </>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: (
      <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6">
        <SkeletonRows rows={6} />
      </div>
    ),
    children: [
      { index: true, element: <BooksPage /> },
      // Route-level code splitting: charts, the Merkle verifier and the charter form load on demand.
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
]);
