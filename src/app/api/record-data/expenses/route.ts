import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { createExpenseRecord, deleteExpenseRecords } from "@/lib/record-data/expenses";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("record-data:expenses");
  if (denied) return denied;

  const body = await request.json();
  const { date, accountTypeId, description, amount } = body;

  if (typeof date !== "string" || !date || !Number.isFinite(Number(accountTypeId)) || !(Number(amount) > 0)) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    const id = await createExpenseRecord({
      date,
      accountTypeId: Number(accountTypeId),
      description: typeof description === "string" ? description : "",
      amount: Number(amount),
    });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await denyUnlessEdit("record-data:expenses");
  if (denied) return denied;

  const body = await request.json();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "No ids provided" }, { status: 400 });
  }

  try {
    await deleteExpenseRecords(ids);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
