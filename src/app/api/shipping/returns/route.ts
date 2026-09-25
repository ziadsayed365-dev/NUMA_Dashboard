import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { bulkRecordReturns } from "@/lib/shipping/orders";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("shipping-orders:returns");
  if (denied) return denied;

  const body = await request.json();
  const numbers = body.numbers;
  if (typeof numbers !== "string" && !Array.isArray(numbers)) {
    return NextResponse.json({ ok: false, error: "numbers is required" }, { status: 400 });
  }
  // No courier or date is accepted: Khazenly is the only courier, and a return
  // is dated by the order's own shipped day.
  try {
    const summary = await bulkRecordReturns(numbers, "khazenly");
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
