import { NextRequest, NextResponse } from "next/server";
import { denyUnlessAgent } from "@/lib/agent/auth";
import { renderReportPdf, reportBaseName } from "@/lib/report-pdf";
import { egyptToday, addDays } from "@/lib/dates";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// The nightly report PDF AI NUMA attaches on Telegram: yesterday's Income
// Statement + Analysis by Product, named "<D Month> NUMA.pdf".
// ?date=YYYY-MM-DD overrides the day.
export async function GET(request: NextRequest) {
  const denied = denyUnlessAgent(request);
  if (denied) return denied;

  const override = request.nextUrl.searchParams.get("date");
  if (override && !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
    return NextResponse.json({ ok: false, error: "invalid date" }, { status: 400 });
  }
  const date = override ?? addDays(egyptToday(), -1);

  // Must be an origin this function can reach to load the print page. APP_URL
  // pins it to the stable production domain; otherwise fall back to whatever
  // host the request hit.
  const baseUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;
  const name = reportBaseName(date);

  try {
    const pdf = await renderReportPdf(baseUrl, date);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}.pdf"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, date, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
