import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { createModelGroup } from "@/lib/products/catalog";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("product-list:products");
  if (denied) return denied;

  const body = await request.json();
  const { name, unitCost } = body;

  if (typeof name !== "string" || !name.trim() || (unitCost !== null && unitCost !== undefined && typeof unitCost !== "number")) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    const id = await createModelGroup({ name, unitCost: unitCost ?? null });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
