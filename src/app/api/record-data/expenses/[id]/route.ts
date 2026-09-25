import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { updateExpenseRecord } from "@/lib/record-data/expenses";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("record-data:expenses");
  if (denied) return denied;

  const { id } = await params;
  const recordId = Number(id);
  const body = await request.json();
  const { date, accountTypeId, description, amount } = body;

  if (!Number.isFinite(recordId) || typeof date !== "string" || !date || !Number.isFinite(Number(accountTypeId)) || !(Number(amount) > 0)) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await updateExpenseRecord(recordId, {
      date,
      accountTypeId: Number(accountTypeId),
      description: typeof description === "string" ? description : "",
      amount: Number(amount),
    });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
