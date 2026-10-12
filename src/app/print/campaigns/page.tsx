import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { canView } from "@/lib/permissions";
import { getCampaignPnl } from "@/lib/reports/campaign-pnl";
import { egyptToday, addDays } from "@/lib/dates";
import { PrintCampaigns } from "./print-campaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Standalone print/PDF view of the Campaigns P&L - the P&L table, then the
// Products Sold summary on a second page. Opened from the page's Export PDF
// button; lives outside the (app) group so it prints without the app chrome.
// Params: from, to (inclusive Egypt days; default yesterday).
export default async function CampaignsPrintPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams;

  const viewer = await getViewer();
  if (!viewer.session) redirect("/login");

  // Each section needs the same right as its on-screen tab, so the export can't
  // become a way around the tab permissions.
  const showPnl = canView(viewer, "campaigns:pnl");
  const showProducts = canView(viewer, "campaigns:products");
  if (!showPnl && !showProducts) redirect("/");

  const to = params.to && params.to.length > 0 ? params.to : addDays(egyptToday(), -1);
  const fromRaw = params.from && params.from.length > 0 ? params.from : to;
  const from = fromRaw <= to ? fromRaw : to;

  const report = await getCampaignPnl(from, to);

  return <PrintCampaigns report={report} showPnl={showPnl} showProducts={showProducts} />;
}
