import "server-only";
import { revalidateTag } from "next/cache";
import { supabase } from "@/lib/supabase";
import { runNightlyAudit, type NightlyAudit } from "@/lib/reports/nightly-audit";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { getPerProductReport } from "@/lib/reports/per-product";
import { egyptToday, addDays } from "@/lib/dates";
import { applyAgentActions } from "@/lib/agent/actions";
import { renderReportPdf, reportBaseName } from "@/lib/report-pdf";
import { sendText, sendPoll, stopPoll, sendDocument } from "@/lib/telegram";

// AI NUMA's questions on Telegram. Everything the report is waiting on goes out
// as its own message - one per TikTok day, one per product with no cost, one
// poll per unallocated ad - and the owner answers each whenever it suits them:
// a reply with the number, or a tap on the poll. The webhook
// (/api/agent/webhook) hands every answer here, it is recorded at once, and
// when nothing is left open the day's report goes out with its PDF.
//
// A NUMA cost is its build (components, or a bundle's contents), which can't be
// typed as one number - so a missing cost is fixed on the dashboard and the
// owner replies "done" to have it re-checked.

type Kind = "tiktok" | "cost" | "allocation";

type PollEntry = { pollId: string; messageId: number; options: string[]; answer: number[] | null };

type RequestRow = {
  id: number;
  kind: Kind | "report";
  item_key: string;
  day: string;
  status: "open" | "done";
  message_id: number | null;
  polls: PollEntry[];
  // A test question (sendTestRequests): answered like a real one, records nothing.
  test: boolean;
  label: string | null;
};

// Telegram's limit on poll options.
const MAX_POLL_OPTIONS = 12;
const GENERAL = "General (all products)";
const ALL_TIME_START = "2000-01-01";

const egp = (n: number) => `${Math.round(n).toLocaleString("en-US")} EGP`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function origin(fallback: string): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : fallback;
}

// The same as POST /api/agent/apply: the reports are cached (src/lib/reports/cache.ts).
function retireReports(): void {
  revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
}

// "3500", "3,500", "3.5k", "٣٥٠٠", "3500 EGP" -> 3500. Null when it isn't a number.
export function parseAmount(text: string): number | null {
  const western = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, ".")
    .replace(/[,٬\s]/g, "")
    .replace(/(egp|le|جنيه|ج\.?م?)$/i, "");
  const m = western.match(/^(\d+(?:\.\d+)?)(k)?$/i);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

// The products General spend is split over - the ones an ad can be for.
async function activeProducts(): Promise<string[]> {
  const { data, error } = await supabase.from("products").select("name, status").order("name");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  return (data ?? []).filter((p) => !p.status || String(p.status).toUpperCase() === "ACTIVE").map((p) => p.name as string);
}

// --- asking -----------------------------------------------------------------

type Asking = { test: boolean; label: string };

// Opens the request, then sends its question. Opening first means two runs
// racing over the same item can't both ask: the second insert hits the
// one-open-request-per-item index and is skipped.
async function open(kind: Kind, itemKey: string, day: string, asking: Asking, send: () => Promise<Partial<RequestRow>>): Promise<boolean> {
  const { data, error } = await supabase
    .from("agent_requests")
    // A test never shares a key with a real question, so it can't block one.
    .insert({ kind, item_key: asking.test ? `test:${itemKey}` : itemKey, day, test: asking.test, label: asking.label })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return false; // already asked and still open
    throw new Error(`Failed to open request: ${error.message}`);
  }
  try {
    const sent = await send();
    await supabase.from("agent_requests").update(sent).eq("id", data.id);
    return true;
  } catch (err) {
    await supabase.from("agent_requests").delete().eq("id", data.id);
    throw err;
  }
}

const testTag = (test: boolean) => (test ? "[TEST - nothing will be saved]\n" : "");

async function askTikTok(date: string, day: string, test = false) {
  return open("tiktok", date, day, { test, label: `TikTok spend for ${fmtDay(date)}` }, async () => ({
    message_id: await sendText(`${testTag(test)}TikTok spend for ${fmtDay(date)}?\n\nReply to this message with the amount in EGP (0 if there was none).`),
  }));
}

async function askCost(p: NightlyAudit["missingCostProducts"][number], day: string, test = false) {
  const where = p.isBundle ? "add its contents" : "add its components";
  return open("cost", String(p.productId), day, { test, label: p.name }, async () => ({
    message_id: await sendText(
      `${testTag(test)}Cost missing: ${p.name}${p.sku ? ` (${p.sku})` : ""}\n${p.unitsSold} sold, last on ${fmtDay(p.lastSoldDay)}\n\n` +
        `Its cost is its build, so it is set on the dashboard: open Final Products and ${where}. Then reply "done" to this message.`
    ),
  }));
}

async function askAllocation(ad: NightlyAudit["unallocatedAds"][number], day: string, test = false) {
  const products = await activeProducts();
  const name = ad.adName ?? ad.campaignName ?? ad.adsetName ?? ad.adId;
  const question =
    `${test ? "[TEST] " : ""}Which products is this ad for?\n${name}\nLast spend ${egp(ad.lastDaySpend)} on ${fmtDay(ad.lastDay)}` +
    (ad.suggestedProduct ? `\nIts page is: ${ad.suggestedProduct}` : "");
  const options = [...products.slice(0, MAX_POLL_OPTIONS - 1), GENERAL];
  return open("allocation", ad.adId, day, { test, label: name }, async () => {
    const { pollId, messageId } = await sendPoll(question, options, true);
    return { polls: [{ pollId, messageId, options, answer: null }] };
  });
}

const outstanding = (a: NightlyAudit) => a.tiktokMissingDays.length + a.missingCostProducts.length + a.unallocatedAds.length;

// Asks for everything the day's report is waiting on that hasn't been asked
// yet. When nothing is outstanding and nothing is still open, sends the report.
export async function askOrReport(day: string, fallbackOrigin: string): Promise<{ asked: number; reported: boolean }> {
  const audit = await runNightlyAudit(day);
  let asked = 0;
  for (const date of audit.tiktokMissingDays) if (await askTikTok(date, day)) asked++;
  for (const p of audit.missingCostProducts) if (await askCost(p, day)) asked++;
  for (const ad of audit.unallocatedAds) if (await askAllocation(ad, day)) asked++;

  if (outstanding(audit) > 0 || (await openCount()) > 0) return { asked, reported: false };
  return { asked, reported: await sendReport(audit, fallbackOrigin) };
}

// One of each question, about real items - a product and the latest Meta ad -
// so the whole flow can be tried on Telegram. Answers are checked and
// confirmed but nothing is saved.
export async function sendTestRequests(day: string): Promise<{ asked: number }> {
  const { data: product, error: productErr } = await supabase.from("products").select("id, name, sku, is_bundle").limit(1).single();
  if (productErr) throw new Error(`Failed to pick a product: ${productErr.message}`);
  const { data: ad, error: adErr } = await supabase
    .from("ad_spend")
    .select("ad_id, ad_name, campaign_name, adset_name, date, spend")
    .eq("source", "meta")
    .not("ad_id", "is", null)
    .order("date", { ascending: false })
    .order("spend", { ascending: false })
    .limit(1)
    .single();
  if (adErr) throw new Error(`Failed to pick an ad: ${adErr.message}`);

  let asked = 0;
  if (await askTikTok(day, day, true)) asked++;
  const sample = { productId: product.id, name: product.name, sku: product.sku, isBundle: !!product.is_bundle, unitsSold: 0, lastSoldDay: day };
  if (await askCost(sample, day, true)) asked++;
  const sampleAd = {
    adId: ad.ad_id as string,
    adName: ad.ad_name,
    campaignName: ad.campaign_name,
    adsetName: ad.adset_name,
    lastDay: String(ad.date).slice(0, 10),
    lastDaySpend: Number(ad.spend),
    totalSpend: Number(ad.spend),
    suggestedProduct: null,
    landingUrl: null,
  };
  if (await askAllocation(sampleAd, day, true)) asked++;
  return { asked };
}

async function openCount(): Promise<number> {
  const { count, error } = await supabase
    .from("agent_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .eq("test", false); // an unanswered test never holds up the report
  if (error) throw new Error(`Failed to count open requests: ${error.message}`);
  return count ?? 0;
}

// --- the report ---------------------------------------------------------------

function reportText(a: NightlyAudit): string {
  const { day, average } = a.comparison;
  const vs = (now: number, avg: number) => (avg ? ` (avg ${egp(avg)}, ${pct((now - avg) / Math.abs(avg))})` : "");
  const roas = (n: number | null) => (n === null ? "-" : n.toFixed(1));
  const lines = [
    `AI NUMA: ${fmtDay(a.day)} report - ${outstanding(a) ? `${outstanding(a)} item(s) still missing` : "all checks passed"}`,
    "",
    `Contribution profit: ${egp(day.contributionProfit)}${vs(day.contributionProfit, average.contributionProfit)}`,
    `Orders: ${day.ordersPlaced} (avg ${Math.round(average.ordersPlaced)}) - Revenue ${egp(day.revenue)}`,
    `Ad spend: ${egp(day.adSpend)} - ROAS ${roas(day.roas)} (avg ${roas(average.roas)})${day.cpa !== null ? ` - ${egp(day.cpa)} per order` : ""}`,
  ];
  // The products that moved most against their own average.
  const movers = a.comparison.products
    .map((p) => ({ p, delta: p.day.contributionProfit - p.average.contributionProfit }))
    .filter(({ p, delta }) => Math.abs(delta) > Math.max(500, Math.abs(p.average.contributionProfit) * 0.1))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 3);
  if (movers.length) {
    lines.push("", "Biggest moves vs average:");
    for (const { p } of movers) {
      lines.push(`- ${p.name}: ${egp(p.day.contributionProfit)} contribution (avg ${egp(p.average.contributionProfit)}), ROAS ${roas(p.day.roas)}`);
    }
  }
  const gaps = a.ties.flatMap((t) =>
    (["revenue", "cogs", "adSpend"] as const)
      .filter((line) => !t[line].ok)
      .map((line) => `- ${t.mode} ${line}: Income Statement ${egp(t[line].incomeStatement)} vs by product ${egp(t[line].byProduct)}`)
  );
  if (gaps.length) lines.push("", "Check on the dashboard - the two reports disagree:", ...gaps);
  return lines.join("\n");
}

const PDF_ATTEMPTS = 3;

// The report (with the Campaigns P&L as its last two pages) never goes out
// without its PDF. If it can't be made, the owner is
// told and can reply "pdf" to try again (handleText).
async function sendReport(audit: NightlyAudit, fallbackOrigin: string, opts: { force?: boolean } = {}): Promise<boolean> {
  // Claimed first, so the report goes out once however many answers land at
  // once. A "pdf" request skips the claim: it was asked for.
  if (!opts.force) {
    const { error } = await supabase
      .from("agent_requests")
      .insert({ kind: "report", item_key: audit.day, day: audit.day, status: "done", resolved_at: new Date().toISOString() });
    if (error) {
      if (error.code === "23505") return false;
      throw new Error(`Failed to claim the report: ${error.message}`);
    }
  }
  const release = () =>
    opts.force ? Promise.resolve() : supabase.from("agent_requests").delete().eq("kind", "report").eq("item_key", audit.day).then(() => {});

  // The print page is built from the whole P&L history; computing it here
  // first leaves it in the shared report cache, so the page renders well inside
  // its timeout instead of computing it all from cold.
  await Promise.all([
    getDailyPnl(ALL_TIME_START, audit.day, "performance"),
    getPerProductReport(audit.day, audit.day, "performance"),
  ]).catch(() => {});

  let pdf: Buffer | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= PDF_ATTEMPTS && !pdf; attempt++) {
    try {
      pdf = await renderReportPdf(origin(fallbackOrigin), audit.day, { campaigns: true });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`report PDF attempt ${attempt} failed:`, err);
    }
  }
  try {
    if (!pdf) {
      await release();
      await sendText(
        `AI NUMA: ${fmtDay(audit.day)} report is ready, but the PDF didn't come out (${lastError.slice(0, 200)}).\n\nReply "pdf" to try again.`
      );
      return false;
    }
    await sendDocument(reportText(audit), pdf, `${reportBaseName(audit.day)}.pdf`);
    return true;
  } catch (err) {
    // Not sent: release the claim so the next answer or run tries again.
    await release();
    throw err;
  }
}

// --- answers ---------------------------------------------------------------------

async function close(id: number): Promise<void> {
  await supabase.from("agent_requests").update({ status: "done", resolved_at: new Date().toISOString() }).eq("id", id);
}

// What to do once an answer is recorded - runs after the webhook has answered
// Telegram, since the report can take a minute to render.
// pdf: the owner asked for the report ("pdf"), sent whatever else is open.
export type FollowUp = { day: string; pdf?: boolean } | null;

export async function followUp(f: FollowUp, fallbackOrigin: string): Promise<void> {
  if (!f) return;
  if (f.pdf) {
    await sendReport(await runNightlyAudit(f.day), fallbackOrigin, { force: true });
    return;
  }
  if ((await openCount()) === 0) await askOrReport(f.day, fallbackOrigin);
}

// A missing cost the owner says is fixed: checked against a fresh audit.
async function recheckCost(request: RequestRow, messageId: number): Promise<FollowUp> {
  if (request.test) {
    await close(request.id);
    await sendText(`Test OK - would re-check the cost of ${request.label}. Nothing was saved.`, messageId);
    return null;
  }
  retireReports();
  const audit = await runNightlyAudit(request.day);
  if (audit.missingCostProducts.some((p) => String(p.productId) === request.item_key)) {
    await sendText(`${request.label} still has no cost. Add its build on Final Products, then reply "done" again.`, messageId);
    return null;
  }
  await close(request.id);
  await sendText(`Got it - ${request.label} now has a cost.`, messageId);
  return { day: request.day };
}

// A text message: the number answering a TikTok question, or "done" for a cost.
export async function handleText(text: string, messageId: number, replyTo: number | null): Promise<FollowUp> {
  // "pdf" / "report" (optionally with a day): send that day's report now.
  const ask = text.trim().match(/^(pdf|report|تقرير)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (ask) {
    const day = ask[2] ?? addDays(egyptToday(), -1);
    await sendText(`Making the ${fmtDay(day)} report...`, messageId);
    return { day, pdf: true };
  }
  let request: RequestRow | null = null;
  if (replyTo) {
    const { data } = await supabase.from("agent_requests").select("*").eq("message_id", replyTo).maybeSingle();
    request = data as RequestRow | null;
    if (request?.status === "done") {
      await sendText("That one is already recorded. To change it, use the dashboard.", messageId);
      return null;
    }
  }
  if (!request) {
    // Not a reply: fine when only one question is waiting for an answer.
    const { data } = await supabase.from("agent_requests").select("*").eq("status", "open").in("kind", ["tiktok", "cost"]);
    const waiting = (data ?? []) as RequestRow[];
    if (waiting.length !== 1) {
      await sendText(
        waiting.length ? "Reply to the question you're answering (swipe left on it)." : "Nothing is waiting for an answer right now.",
        messageId
      );
      return null;
    }
    request = waiting[0];
  }
  if (request.kind === "cost") return recheckCost(request, messageId);
  if (request.kind !== "tiktok") {
    await sendText("Answer that one by tapping the poll.", messageId);
    return null;
  }

  const amount = parseAmount(text.trim());
  if (amount === null) {
    await sendText("Send just the amount, e.g. 3500 (0 if none)", messageId);
    return null;
  }
  if (request.test) {
    await close(request.id);
    await sendText(`Test OK - would record ${request.label}: ${amount.toLocaleString("en-US")} EGP. Nothing was saved.`, messageId);
    return null;
  }

  const [result] = await applyAgentActions([{ type: "set_tiktok_spend", date: request.item_key, amount }]);
  if (result.ok || /already/i.test(result.detail)) {
    if (result.ok) retireReports();
    await close(request.id);
    await sendText(result.ok ? `Recorded - ${result.detail}` : result.detail, messageId);
    return { day: request.day };
  }
  await sendText(`Couldn't record it: ${result.detail}`, messageId);
  return null;
}

// A vote on an allocation poll: one or more products, or General.
export async function handlePollAnswer(pollId: string, optionIds: number[]): Promise<FollowUp> {
  if (optionIds.length === 0) return null; // vote withdrawn
  const { data } = await supabase
    .from("agent_requests")
    .select("*")
    .eq("kind", "allocation")
    .eq("status", "open")
    // jsonb containment; .contains() would send an array as a Postgres array.
    .filter("polls", "cs", JSON.stringify([{ pollId }]));
  const request = (data?.[0] ?? null) as RequestRow | null;
  if (!request) return null;

  const poll = request.polls[0];
  if (poll.pollId !== pollId || poll.answer) return null;
  poll.answer = optionIds;
  await stopPoll(poll.messageId);
  await supabase.from("agent_requests").update({ polls: request.polls }).eq("id", request.id);

  const picked = optionIds.map((i) => poll.options[i]);
  const general = picked.includes(GENERAL);
  const productNames = general ? [] : picked;
  const target = general ? GENERAL : productNames.join(", ");
  if (request.test) {
    await close(request.id);
    await sendText(`Test OK - would allocate ${request.label} to ${target}. Nothing was saved.`, poll.messageId);
    return null;
  }

  const [result] = await applyAgentActions([{ type: "allocate_ad", adId: request.item_key, productNames, general }]);
  if (result.ok || /already/i.test(result.detail)) {
    if (result.ok) retireReports();
    await close(request.id);
    await sendText(result.ok ? `Allocated to ${target}.` : result.detail, poll.messageId);
    return { day: request.day };
  }
  // Not saved: drop it, so the follow-up asks again from the top.
  await sendText(`Couldn't allocate it: ${result.detail}`, poll.messageId);
  await supabase.from("agent_requests").delete().eq("id", request.id);
  return { day: request.day };
}
