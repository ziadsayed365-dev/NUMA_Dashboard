import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeSupabaseError, withRetry } from "@/lib/retry";

const PAGE_SIZE = 1000;
// How many page requests to keep in flight at once. The dataset lives in
// eu-west-1 and each page is a full network round-trip (~0.7s), so fetching
// ~36 order pages one-after-another dominated report page loads. Fanning the
// pages out concurrently turns that from sum-of-latencies into
// max-of-latencies per batch. Capped so a full scan can't open dozens of
// simultaneous connections against the pooler.
const CONCURRENCY = 6;

// Runs one query with the transient-failure retry, then labels whatever
// survives with what was being attempted. The retry has to see the raw
// PostgREST reason - prefixing it first would hide the very words isTransient
// matches on - so the label goes on only once the retries are spent.
async function run<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withRetry(fn);
  } catch (err) {
    throw new Error(`Failed to ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Supabase/PostgREST caps results at 1000 rows by default. Any query that
// could exceed that must paginate with a stable order, or rows get
// silently skipped/duplicated as the underlying data changes between pages.
//
// We first ask for an exact count (head-only, no rows transferred), then
// fetch every page range concurrently with bounded parallelism, reassembling
// them in order. Falls back to sequential paging if the count is unavailable.
export async function fetchAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  selectClause: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic query-builder callback, no narrower type available across all callers
  applyFilters?: (query: any) => any,
  orderBy: string[] = ["id"] // must be a key (or combination) that's unique across all rows, or pagination can skip/duplicate rows
): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildPageQuery(): any {
    let query = supabase.from(table).select(selectClause);
    if (applyFilters) query = applyFilters(query);
    for (const col of orderBy) query = query.order(col, { ascending: true });
    return query;
  }

  // Head-only exact count. Uses the same select (and thus the same embeds)
  // so callers whose filters reference an embedded resource still resolve.
  // Retried: this one query gates every report and every compute step, so a
  // single Cloudflare blip in front of Supabase used to fail a whole Sync -
  // and with an empty message, leaving nothing to diagnose from.
  const count = await run(`count ${table}`, async () => {
    let countQuery = supabase.from(table).select(selectClause, { count: "exact", head: true });
    if (applyFilters) countQuery = applyFilters(countQuery);
    const { count, error: countErr } = await countQuery;
    if (countErr) throw new Error(describeSupabaseError(countErr));
    return count;
  });

  // Count unavailable (some views): fall back to the classic sequential walk.
  if (count === null || count === undefined) {
    const rows: T[] = [];
    let from = 0;
    while (true) {
      const data = await run(`fetch ${table}`, async () => {
        const { data, error } = await buildPageQuery().range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(describeSupabaseError(error));
        return data;
      });
      rows.push(...((data ?? []) as T[]));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return rows;
  }

  if (count === 0) return [];

  const pageCount = Math.ceil(count / PAGE_SIZE);
  const pages: T[][] = new Array(pageCount);
  let nextPage = 0;

  async function worker(): Promise<void> {
    while (true) {
      const p = nextPage++;
      if (p >= pageCount) return;
      const start = p * PAGE_SIZE;
      const data = await run(`fetch ${table} rows ${start}-${start + PAGE_SIZE - 1}`, async () => {
        const { data, error } = await buildPageQuery().range(start, start + PAGE_SIZE - 1);
        if (error) throw new Error(describeSupabaseError(error));
        return data;
      });
      pages[p] = (data ?? []) as T[];
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageCount) }, () => worker()));
  return pages.flat();
}
