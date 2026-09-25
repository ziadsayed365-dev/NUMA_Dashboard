import { NextRequest, NextResponse } from "next/server";
import { denyUnlessView } from "@/lib/access";
import { getShipmentReport } from "@/lib/purchases/shipment-report";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await denyUnlessView("purchasing:report");
  if (denied) return denied;
  try {
    const report = await getShipmentReport();
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
