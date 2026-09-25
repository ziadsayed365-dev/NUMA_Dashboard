import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { createFixedAsset, deleteFixedAsset } from "@/lib/settings/fixed-assets";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:assets");
  if (denied) return denied;

  const body = await request.json();
  const { name, purchaseDate, amount, usefulLifeYears } = body;

  if (typeof name !== "string" || !name.trim() || typeof purchaseDate !== "string") {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await createFixedAsset({ name, purchaseDate, amount: Number(amount), usefulLifeYears: Number(usefulLifeYears) });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:assets");
  if (denied) return denied;

  const body = await request.json();
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  try {
    await deleteFixedAsset(id);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
