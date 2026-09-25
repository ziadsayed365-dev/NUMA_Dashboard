import { NextRequest, NextResponse } from "next/server";
import { denyUnlessView } from "@/lib/access";
import { getAnalysisExportRows, toCsv } from "@/lib/shipping/analysis-export";
import { isShippingCourier } from "@/lib/shipping/shared";
import type { ShippingCourier } from "@/lib/shipping/shared";

export const dynamic = "force-dynamic";

// The orders behind one cell of the Analysis tab's delivery-rate table. A GET
// returning a file attachment, so the click can be a plain link the browser
// downloads - no fetch/blob juggling in the client. Gated on the same permission
// as the tab itself, since it hands out order-level detail.
export async function GET(request: NextRequest) {
  const denied = await denyUnlessView("shipping-orders:analysis");
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const month = params.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ ok: false, error: "month must be YYYY-MM" }, { status: 400 });
  }

  // Narrowed inside the block so isShippingCourier's type guard actually applies -
  // checking and returning early leaves the value as a plain string afterwards.
  const courierParam = params.get("courier");
  let courier: ShippingCourier | null = null;
  if (courierParam !== null) {
    if (!isShippingCourier(courierParam)) {
      return NextResponse.json({ ok: false, error: "unknown courier" }, { status: 400 });
    }
    courier = courierParam;
  }

  const productParam = params.get("productId");
  const productId = productParam ? Number(productParam) : null;
  if (productParam && !Number.isFinite(productId)) {
    return NextResponse.json({ ok: false, error: "productId must be a number" }, { status: 400 });
  }

  try {
    const rows = await getAnalysisExportRows({ month, courier, productId });
    const scope = courier ?? (productParam ? `product-${productId}` : "all-couriers");
    const filename = `delivery-${scope}-${month}.csv`;

    return new NextResponse(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
