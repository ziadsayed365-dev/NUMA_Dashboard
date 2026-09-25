import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit } from "@/lib/access";
import { deletePerfExpenseEntry, upsertPerfExpenseEntry } from "@/lib/settings/fixed-expenses";

export const dynamic = "force-dynamic";

// Add/update one account's amount effective from a given month.
export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:expenses");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const account = String(body.account ?? "");
  const month = String(body.effectiveMonth ?? "");
  const amount = Number(body.amount);

  try {
    await upsertPerfExpenseEntry(account, month, amount);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}

// Remove one account's effective entry.
export async function DELETE(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:expenses");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const account = String(body.account ?? "");
  const month = String(body.effectiveMonth ?? "");

  try {
    await deletePerfExpenseEntry(account, month);
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
