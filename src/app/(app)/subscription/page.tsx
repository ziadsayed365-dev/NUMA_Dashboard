import { requirePageView } from "@/lib/access";
import { getSubscriptionDashboard } from "@/lib/subscriptions/subscriptions";
import { SubscriptionView } from "./subscription-view";
import { NoAccess } from "../no-access";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  const viewer = await requirePageView("subscription");
  if (!viewer) return <NoAccess />;

  const dashboard = await getSubscriptionDashboard();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Subscription</h1>
        <p className="text-xs text-gray-400">
          numa Focus monthly subscribers. Each Shopify order with the Subscription product is one paid month — create the
          month&apos;s order in Shopify, then Sync, and the customer&apos;s renewal moves forward a month.
        </p>
      </div>

      <SubscriptionView dashboard={dashboard} />
    </div>
  );
}
