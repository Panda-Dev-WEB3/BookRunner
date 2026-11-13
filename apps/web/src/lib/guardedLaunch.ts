// Guarded launch (VITE_GUARDED_LAUNCH, lib/features.ts): the copy of the launch-phase banner and the deposit gate.
// Pure: unit-tested in test/guarded-launch.test.ts. The gate only ever closes deposits (subscription commitments and
// top-up deposits); withdrawals, claims and every other exit stay open whatever it says.

/** The public site's official-links page (contract addresses, the X account, the "we never DM you" notice). */
export const OFFICIAL_LINKS_URL = "/official-links/";

/** sessionStorage key: the banner stays dismissed for this browser session only. */
export const BANNER_DISMISSED_KEY = "bkrn.guardedLaunchBanner.dismissed";

/** Book states with a deposit round that can be open: a new book's subscription window, or a Live book's top-up round. */
export const DEPOSIT_STATES: ReadonlySet<string> = new Set(["Subscription", "Live"]);

export const GUARDED_COPY = {
  bannerLead: "Guarded launch.",
  banner: "Bookrunner is in its launch phase on Robinhood Chain and no public market is open yet. Check every address against the official links before you sign.",
  bannerLink: "Official links",
  dismiss: "Hide this notice for this session",
  gateTitle: "Deposits are not open yet",
  gateBody:
    "During the guarded launch, deposits open only when a book is in its subscription window or live. No book is there yet, so investing is turned off for now. Withdrawals and claims are never blocked.",
} as const;

export type InvestGate =
  /** deposits may open (per book, by its own window) */
  | { status: "open" }
  /** the book list is not loaded yet: keep deposit buttons disabled, say nothing */
  | { status: "loading" }
  /** guarded launch and no book in Subscription or Live: deposits stay closed with GUARDED_COPY.gate* */
  | { status: "closed" };

/**
 * Whether deposits may open at all. Outside a guarded launch always open (each book's window decides). In a guarded
 * launch, open only once some book is in Subscription or Live, from the book list the app already loads.
 */
export function investGate(guarded: boolean, bookStates: readonly string[] | undefined): InvestGate {
  if (!guarded) return { status: "open" };
  if (bookStates === undefined) return { status: "loading" };
  return bookStates.some((s) => DEPOSIT_STATES.has(s)) ? { status: "open" } : { status: "closed" };
}
