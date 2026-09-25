import { NextRequest, NextResponse } from "next/server";
import { denyUnlessEdit } from "@/lib/access";
import { getAdProductSuggestions } from "@/lib/reports/ad-product-suggestion";

export const dynamic = "force-dynamic";

// Read-only, but a POST because it takes a list of ad ids. Gated on the same
// permission as the allocation it feeds, so exactly the people who can act on a
// suggestion can see it. Fetched from the popup after it opens, rather than
// resolved on the page, so a slow Meta call can't hold up the report behind it.
export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:ads");
  if (denied) return denied;

  const body = await request.json();
  const adIds: unknown = body?.adIds;
  if (!Array.isArray(adIds) || adIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    const suggestions = await getAdProductSuggestions(adIds as string[]);
    return NextResponse.json({ ok: true, suggestions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
