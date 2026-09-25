import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessEdit, denyUnlessView } from "@/lib/access";
import {
  deleteInventoryGroup,
  getGroupingModel,
  getInventoryLedger,
  saveInventoryAdjustment,
  saveInventoryGroup,
  saveOpeningBalances,
  type ItemKind,
} from "@/lib/inventory/inventory";
import type { ComponentUnit } from "@/lib/products/component-types";

export const dynamic = "force-dynamic";

// Was owner + the old `operations` role; now it's the Purchasing → Inventory
// tab. Reading the ledger takes view; everything below writes stock, so it takes
// the tab's edit right - a view-only account can open the ledger and type
// nothing into it.
const INVENTORY = "purchasing:inventory";

function asKind(v: unknown): ItemKind {
  return v === "group" ? "group" : "component";
}

export async function GET(request: NextRequest) {
  const denied = await denyUnlessView(INVENTORY);
  if (denied) return denied;
  try {
    // ?grouping=1 asks for the group editor's model instead of the ledger.
    if (request.nextUrl.searchParams.get("grouping")) {
      return NextResponse.json({ ok: true, grouping: await getGroupingModel() });
    }
    const ledger = await getInventoryLedger();
    return NextResponse.json({ ok: true, ledger });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

// Three writes share this route: an Adjustments cell, a group definition, and
// the opening-balance form (every line + the start date).
export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit(INVENTORY);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  try {
    // One edited (monthly) cell of the Adjustments row. No report cache to drop:
    // adjustments move stock, not money, and the cell is typed in day by day.
    if (body.adjustment) {
      const a = body.adjustment as Record<string, unknown>;
      await saveInventoryAdjustment({
        kind: asKind(a.kind),
        id: Number(a.id),
        month: String(a.month ?? ""),
        quantity: Number(a.quantity),
      });
      return NextResponse.json({ ok: true });
    }

    if (body.group) {
      const g = body.group as Record<string, unknown>;
      await saveInventoryGroup({
        id: g.id == null ? null : Number(g.id),
        name: String(g.name ?? ""),
        unit: String(g.unit ?? "pcs") as ComponentUnit,
        componentIds: (Array.isArray(g.componentIds) ? g.componentIds : []).map((x) => Number(x)),
      });
      // The figures behind the Income Statement just changed - drop the cached
      // reports so the next page load rebuilds with this in it.
      revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

      return NextResponse.json({ ok: true });
    }

    if (body.deleteGroupId != null) {
      await deleteInventoryGroup(Number(body.deleteGroupId));
      // The figures behind the Income Statement just changed - drop the cached
      // reports so the next page load rebuilds with this in it.
      revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

      return NextResponse.json({ ok: true });
    }

    const raw = Array.isArray(body.balances) ? body.balances : [];
    await saveOpeningBalances({
      startDate: String(body.startDate ?? ""),
      balances: raw.map((b) => {
        const row = b as Record<string, unknown>;
        return { kind: asKind(row.kind), id: Number(row.id), quantity: Number(row.quantity) };
      }),
    });
    // The figures behind the Income Statement just changed - drop the cached
    // reports so the next page load rebuilds with this in it.
    revalidateTag(REPORT_CACHE_TAG, { expire: 0 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 400 });
  }
}
