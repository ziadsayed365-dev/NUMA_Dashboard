import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { NoAccess } from "../no-access";
import { getShipperSummary } from "@/lib/shipping/orders";
import { getShippingAnalysis } from "@/lib/shipping/analysis";
import { getDeliveryRates, getProductMonthlyRates } from "@/lib/shipping/delivery-rate";
import { ShippingTabs } from "../shipping-tabs";

export const dynamic = "force-dynamic";
// Scans every line item ever to build the per-product monthly rates; same
// cold-cache exposure as the dashboard, so it gets the same budget.
export const maxDuration = 300;

export default async function ShippingOrdersPage() {
  const viewer = await requirePageView("shipping-orders");
  if (!viewer) return <NoAccess />;

  const [summary, analysis, rates, productRates] = await Promise.all([
    getShipperSummary("khazenly"),
    getShippingAnalysis(),
    getDeliveryRates(),
    getProductMonthlyRates(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Shipping Orders</h1>
        <p className="text-xs text-gray-400">
          Courier: Khazenly. Shipments and delivery status come from Shopify; record returns here.
        </p>
      </div>

      <ShippingTabs
        summaries={[summary]}
        analysis={analysis}
        rates={rates}
        productRates={productRates}
        access={{
          returns: { view: canView(viewer, "shipping-orders:returns"), edit: canEdit(viewer, "shipping-orders:returns") },
          analysis: { view: canView(viewer, "shipping-orders:analysis"), edit: false },
        }}
      />
    </div>
  );
}
