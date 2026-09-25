import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { deleteProductComponentMapping, upsertProductComponentMapping } from "@/lib/products/final-products";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("product-list:final");
  if (denied) return denied;

  const { id } = await params;
  const productId = Number(id);
  const body = await request.json();
  const componentId = Number(body.componentId);
  const quantity = Number(body.quantity);

  if (!Number.isFinite(productId) || !Number.isFinite(componentId) || !Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await upsertProductComponentMapping(productId, componentId, quantity);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("product-list:final");
  if (denied) return denied;

  const { id } = await params;
  const productId = Number(id);
  const body = await request.json();
  const componentId = Number(body.componentId);

  if (!Number.isFinite(productId) || !Number.isFinite(componentId)) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await deleteProductComponentMapping(productId, componentId);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
