// Shared cache settings for the expensive report reads (Income Statement and
// Analysis by Product).
//
// Why these are cached at all: every page is `force-dynamic` (they read the
// session cookie), and they ask for the full history on each load, so a plain
// refresh used to re-run the whole report against Supabase. The numbers only
// change when a sync writes new rows, so serving a slightly stale report for a
// short window is free in practice and removes the repeat cost entirely.
//
// Every route that writes a figure the reports read now drops this cache on
// save (revalidateTag below), so the window is a backstop rather than the way
// changes surface - a save shows up immediately, not when the timer expires.

export const REPORT_CACHE_SECONDS = 900;

/** Lets the Sync route drop every report at once via revalidateTag. */
export const REPORT_CACHE_TAG = "reports";
