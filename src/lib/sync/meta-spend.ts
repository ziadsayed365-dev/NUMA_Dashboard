import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchMetaAdInsights } from "@/lib/meta";
import { egyptToday } from "@/lib/dates";

const TIME_BUDGET_MS = 45_000; // leave headroom under Vercel's 60s function limit
const RECHECK_DAYS = 3; // re-pull the last few days each run to catch Meta's attribution corrections

type SyncResult = {
  ok: boolean;
  daysProcessed: number;
  rowsUpserted: number;
  reachedEnd: boolean;
  error?: string;
};

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

export async function syncMetaSpend(): Promise<SyncResult> {
  const startedAt = Date.now();

  try {
    const { data: state, error: stateErr } = await supabase
      .from("sync_state")
      .select("*")
      .eq("source", "meta")
      .single();
    if (stateErr) throw new Error(`Failed to read sync_state: ${stateErr.message}`);

    let cursor = state?.cursor ?? null;

    if (!cursor) {
      const { data: earliestOrder } = await supabase
        .from("orders")
        .select("order_created_at")
        .order("order_created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      cursor = earliestOrder ? toDateString(new Date(earliestOrder.order_created_at)) : addDays(toDateString(new Date()), -90);
    } else {
      // Re-check the last few days too, in case Meta revised the spend figures.
      cursor = addDays(cursor, -RECHECK_DAYS);
    }

    // Sync through today (Egypt day, matching orders.egypt_day) rather than
    // stopping at yesterday - today's figure is provisional and will keep
    // getting corrected by the RECHECK_DAYS window on later runs, the same
    // way Meta's own attribution corrections are handled.
    const today = egyptToday();

    let daysProcessed = 0;
    let rowsUpserted = 0;
    let reachedEnd = false;
    let date = cursor;

    while (date <= today) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const rows = await fetchMetaAdInsights(date, date);
      for (const row of rows) {
        // product_id is intentionally omitted: the upsert leaves an
        // already-allocated ad's product_id untouched on conflict, and the
        // assignment re-apply below fills newly-inserted rows.
        const { error: upsertErr } = await supabase.from("ad_spend").upsert(
          {
            date: row.date_start,
            source: "meta",
            ad_id: row.ad_id,
            ad_name: row.ad_name ?? null,
            adset_id: row.adset_id ?? null,
            adset_name: row.adset_name ?? null,
            campaign_id: row.campaign_id ?? null,
            campaign_name: row.campaign_name ?? null,
            account_id: row.accountId,
            spend: row.spend,
            currency: "EGP",
            synced_at: new Date().toISOString(),
          },
          { onConflict: "date,source,ad_id" }
        );
        if (upsertErr) throw new Error(`Failed to upsert ad_spend for ${date}: ${upsertErr.message}`);
        rowsUpserted++;
      }

      daysProcessed++;
      await supabase
        .from("sync_state")
        .update({ cursor: date, updated_at: new Date().toISOString() })
        .eq("source", "meta");

      date = addDays(date, 1);
    }

    if (date > today) {
      reachedEnd = true;
      await supabase
        .from("sync_state")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("source", "meta");
    }

    // Newly-inserted rows always come in with product_id null (the upsert
    // above never sets it) - re-apply any ad the owner has already allocated
    // before, so an ad doesn't need re-allocating every time it spends on a new
    // day.
    const { data: assignments, error: assignmentsErr } = await supabase.from("ad_assignments").select("ad_id, product_id");
    if (assignmentsErr) throw new Error(`Failed to load ad assignments: ${assignmentsErr.message}`);
    for (const a of assignments ?? []) {
      // A null product_id means the ad is marked "General" - leave its new days
      // untargeted (product_id null) so they keep being split across all products.
      if (a.product_id == null) continue;
      await supabase.from("ad_spend").update({ product_id: a.product_id }).is("product_id", null).eq("ad_id", a.ad_id);
    }

    return { ok: true, daysProcessed, rowsUpserted, reachedEnd };
  } catch (err) {
    return {
      ok: false,
      daysProcessed: 0,
      rowsUpserted: 0,
      reachedEnd: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}
