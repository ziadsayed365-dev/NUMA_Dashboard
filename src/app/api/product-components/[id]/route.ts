import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { updateProductComponent } from "@/lib/products/components";

export const dynamic = "force-dynamic";

function parseCost(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return Number(value);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("product-list:components");
  if (denied) return denied;

  const { id } = await params;
  const componentId = Number(id);
  if (!Number.isFinite(componentId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json();
  try {
    await updateProductComponent(componentId, {
      type: body.type,
      account: typeof body.account === "string" ? body.account : "",
      unit: body.unit,
      cost: parseCost(body.cost),
    });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
