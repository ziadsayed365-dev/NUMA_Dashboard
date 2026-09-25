import "server-only";
import puppeteer, { type Browser } from "puppeteer-core";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

// Renders the standalone /print/income-statement view to a real PDF buffer, for
// AI NUMA's nightly Telegram report (GET /api/agent/pdf).
//
// The on-screen "Export PDF" button just opens that page and lets the browser's
// Save-as-PDF dialog do the work, which needs a human. The agent needs a file,
// so here we drive a headless Chromium ourselves and call page.pdf().
//
// On Vercel we use @sparticuz/chromium (a Lambda-sized Chromium build); locally
// we point puppeteer-core at whatever Chrome is already installed, via
// LOCAL_CHROME_PATH. Nothing downloads a browser at install time - that's why
// this is puppeteer-core and not puppeteer.

const PAGE_TIMEOUT_MS = 120_000;

// A4 inside the 10mm margins below, in CSS pixels (96 per inch): 190 x 277 mm.
const A4_CONTENT_WIDTH_PX = 718;
const A4_CONTENT_HEIGHT_PX = 1047;
// Room each page keeps for what sits outside a section: the report's own
// padding (24px top and bottom) and the gap above Analysis by Product (32px),
// plus a little slack so rounding never tips a section onto a new page.
const SECTION_ALLOWANCE_PX = 100;

// "2026-07-20" -> "20 July NUMA" (the caller appends .pdf).
export function reportBaseName(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const day = d.getUTCDate();
  const month = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${day} ${month} NUMA`;
}

async function launch(): Promise<Browser> {
  const localPath = process.env.LOCAL_CHROME_PATH?.trim();
  if (localPath) {
    return puppeteer.launch({
      executablePath: localPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }

  // Serverless: @sparticuz/chromium unpacks a Chromium into /tmp on first call.
  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    defaultViewport: { width: 1240, height: 1754 }, // A4 @ ~150dpi
    headless: true,
  });
}

// `baseUrl` must be an absolute origin the function can reach (its own
// deployment URL). `date` is the single day the report covers: the Income
// Statement for that day, then Analysis by Product.
export async function renderReportPdf(baseUrl: string, date: string): Promise<Buffer> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set - cannot authenticate the PDF renderer");

  const origin = baseUrl.replace(/\/+$/, "");
  const url =
    `${origin}/print/income-statement?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}` +
    `&is=1&product=1&auto=0`;

  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();

    // The print page needs a session (it redirects to /login otherwise). Mint a
    // real owner token rather than posting credentials - same secret, no
    // password round-trip.
    const { hostname } = new URL(origin);
    await browser.setCookie({
      name: SESSION_COOKIE_NAME,
      value: createSessionToken({ role: "owner", userId: null }, secret),
      domain: hostname,
      path: "/",
      httpOnly: true,
      secure: origin.startsWith("https://"),
    });

    const res = await page.goto(url, { waitUntil: "networkidle0", timeout: PAGE_TIMEOUT_MS });
    if (!res || !res.ok()) throw new Error(`Print page returned ${res?.status() ?? "no response"}`);

    // A redirect to /login means the cookie didn't take - fail loudly instead of
    // sending a PDF of the login screen.
    if (new URL(page.url()).pathname !== "/print/income-statement") {
      throw new Error(`Print page redirected to ${page.url()} - session cookie rejected`);
    }

    const body = (await page.evaluate(() => document.body.innerText)) ?? "";
    if (body.includes("No data in the selected range")) {
      throw new Error(`No data for ${date} - the report would be empty`);
    }

    // One page per section: the Income Statement, then Analysis by Product. Lay
    // the page out at the printed width, then shrink any section taller than one
    // A4 page until it fits, rather than let it spill onto a second page.
    await page.setViewport({ width: A4_CONTENT_WIDTH_PX, height: A4_CONTENT_HEIGHT_PX });
    await page.emulateMediaType("print");
    await page.evaluate((maxHeight) => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        const height = el.getBoundingClientRect().height;
        if (height > maxHeight) el.style.zoom = String(maxHeight / height);
      }
    }, A4_CONTENT_HEIGHT_PX - SECTION_ALLOWANCE_PX);

    const pdf = await page.pdf({
      format: "a4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}
