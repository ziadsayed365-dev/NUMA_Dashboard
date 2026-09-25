import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Reads the target out of the body. Current shape: { isGeneral: true } or
// { productIds: [..] } (one or more). The older { productId: number | null }
// (null = General) is still accepted.
function parseTarget(body: Record<string, unknown>): { general: true } | { productIds: number[] } | null {
  if (body.isGeneral === true || (body.productIds === undefined && body.productId === null)) return { general: true };
  const raw = body.productIds ?? (typeof body.productId === "number" ? [body.productId] : undefined);
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => !Number.isInteger(v))) return null;
  // De-duplicated: the same product twice would double its own share.
  return { productIds: [...new Set(raw as number[])] };
}

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:ads");
  if (denied) return denied;

  const body = await request.json();
  const adId = body?.adId;
  const target = typeof body === "object" && body ? parseTarget(body) : null;
  if (typeof adId !== "string" || !adId || !target) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    let productId: number | null = null;
    let productIds: number[] | null = null;
    if ("productIds" in target) {
      const { data: found, error: findErr } = await supabase.from("products").select("id").in("id", target.productIds);
      if (findErr) throw new Error(`Failed to check products: ${findErr.message}`);
      if ((found ?? []).length !== target.productIds.length) {
        return NextResponse.json({ ok: false, error: "Unknown product" }, { status: 400 });
      }
      // One product is stamped straight onto the spend; several stay null on
      // ad_spend and are split equally at read time (see per-product.ts).
      if (target.productIds.length === 1) productId = target.productIds[0];
      else productIds = target.productIds;
    }

    const { error: assignErr } = await supabase
      .from("ad_assignments")
      .upsert(
        { ad_id: adId, product_id: productId, product_ids: productIds, updated_at: new Date().toISOString() },
        { onConflict: "ad_id" }
      );
    if (assignErr) throw new Error(`Failed to save assignment: ${assignErr.message}`);

    // A single product stamps every day already on record for this ad (future
    // days get backfilled by the Meta sync). General and multi-product leave
    // product_id null so the report splits the spend; the assignment row above
    // is what stops the ad reappearing in the popup.
    const { error: updateErr } = await supabase.from("ad_spend").update({ product_id: productId }).eq("ad_id", adId);
    if (updateErr) throw new Error(`Failed to allocate existing spend: ${updateErr.message}`);

    // The unmapped-ads list is cached (src/lib/reports/cache.ts) - drop it so the
    // popup reflects this allocation straight away.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

// Undo an allocation: drop the ad's assignment and put its spend back to
// unallocated (product_id null), so it returns to the "needs a product" popup.
// Works for a single-product, multi-product or General allocation.
export async function DELETE(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:ads");
  if (denied) return denied;

  const body = await request.json();
  const { adId } = body;
  if (typeof adId !== "string" || !adId) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    const { error: delErr } = await supabase.from("ad_assignments").delete().eq("ad_id", adId);
    if (delErr) throw new Error(`Failed to remove assignment: ${delErr.message}`);

    const { error: updateErr } = await supabase.from("ad_spend").update({ product_id: null }).eq("ad_id", adId);
    if (updateErr) throw new Error(`Failed to un-allocate spend: ${updateErr.message}`);

    // The popup's unmapped list is cached - this ad belongs back in it now.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
