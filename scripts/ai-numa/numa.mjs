// AI NUMA's hands. Each command does one thing the owner would do by hand on
// the live dashboard, so the agent can run them in order and stop on trouble:
//
//   node numa.mjs sync                  press Sync (every step, in the button's order)
//   node numa.mjs audit [day]           TikTok entered?, unallocated ads, missing costs, report tie-out -> out/audit.json
//   node numa.mjs pdf [day]             the report PDF (Income Statement + Analysis by Product) -> out/numa-<day>.pdf
//   node numa.mjs tg <body-file> [pdf]  send a message on Telegram, optionally with the PDF
//   node numa.mjs replies               the owner's unread Telegram replies
//   node numa.mjs wait [minutes]        wait up to 8 min (and until 1 AM Cairo) for a reply
//   node numa.mjs apply <actions-file>  record TikTok spend / allocate ads he asked for
//
// Env: NUMA_URL and NUMA_CRON_SECRET (the dashboard's CRON_SECRET). The
// Telegram bot token lives on the dashboard, not here. No npm install needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(OUT, { recursive: true });

// Mirrors src/app/(app)/sync-button.tsx: the paginated pulls re-run until they
// report reachedEnd, then the compute chain runs once each, in order. Khazenly
// has no step - its delivery status rides along on the Shopify orders.
const PULL_STEPS = ["meta", "shopify", "shopify-products"];
const COMPUTE_STEPS = ["calibrate", "monthly-rate", "sku-monthly-rate", "margins"];
const MAX_RUNS_PER_STEP = 60;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const base = () => env("NUMA_URL").replace(/\/$/, "");
const cronHeaders = () => ({ authorization: `Bearer ${env("NUMA_CRON_SECRET")}` });

function yesterdayInEgypt() {
  // Same fixed +3h the dashboard's egyptToday() uses, so both agree on "yesterday".
  return new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
}

// A step can time out on one slow Meta response (HTTP 504) and pass on the next
// try. Every step only re-reads and saves the same data, so running it again is
// safe.
const STEP_ATTEMPTS = 2;

async function syncStep(step) {
  let last;
  for (let i = 1; i <= STEP_ATTEMPTS; i++) {
    const res = await fetch(`${base()}/api/sync/run?step=${step}`, { method: "POST", headers: cronHeaders() });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    last = { ok: res.ok && data.ok, data, error: data.error ?? res.status };
    if (last.ok) return last;
    console.log(`${step}: failed (${last.error})${i < STEP_ATTEMPTS ? ", trying again" : ""}`);
  }
  return last;
}

async function sync() {
  const results = [];
  const fail = (step, error) => {
    fs.writeFileSync(path.join(OUT, "sync.json"), JSON.stringify({ ok: false, failedStep: step, error, results }, null, 2));
    console.log(`${step}: FAILED - ${error}`);
    process.exit(1);
  };

  for (const step of PULL_STEPS) {
    for (let run = 1; run <= MAX_RUNS_PER_STEP; run++) {
      const attempt = await syncStep(step);
      results.push(attempt.data);
      if (!attempt.ok) fail(step, attempt.error);
      if (attempt.data.reachedEnd !== false) break;
    }
    console.log(`${step}: ok`);
  }
  for (const step of COMPUTE_STEPS) {
    const attempt = await syncStep(step);
    results.push(attempt.data);
    if (!attempt.ok) fail(step, attempt.error);
    console.log(`${step}: ok`);
  }
  fs.writeFileSync(path.join(OUT, "sync.json"), JSON.stringify({ ok: true, results }, null, 2));
}

async function audit(day = yesterdayInEgypt()) {
  const res = await fetch(`${base()}/api/agent/audit?day=${day}`, { headers: cronHeaders() });
  const data = await res.json();
  fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

// Rendered by the dashboard itself (headless Chromium on the server), so no
// browser is needed here.
async function pdf(day = yesterdayInEgypt()) {
  const res = await fetch(`${base()}/api/agent/pdf?date=${day}`, { headers: cronHeaders() });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("pdf")) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `PDF failed (HTTP ${res.status})`);
  }
  const file = path.join(OUT, `numa-${day}.pdf`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(file);
}

// Telegram, relayed by the dashboard (POST /api/agent/telegram): Claude's cloud
// sandbox permits only HTTPS, and the bot token stays there. `replies` returns
// each message once - reading one marks it read, so act on what comes back
// rather than expecting to see it again.
async function tg(bodyFile, attachment) {
  if (!bodyFile) throw new Error("usage: tg <body-file> [attachment]");
  const res = await fetch(`${base()}/api/agent/telegram`, {
    method: "POST",
    headers: { ...cronHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      text: fs.readFileSync(bodyFile, "utf8"),
      pdfBase64: attachment ? fs.readFileSync(attachment).toString("base64") : undefined,
      filename: attachment ? path.basename(attachment) : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `Telegram send failed (HTTP ${res.status})`);
  console.log("sent on Telegram");
}

async function readReplies() {
  const res = await fetch(`${base()}/api/agent/telegram`, { headers: cronHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `Telegram read failed (HTTP ${res.status})`);
  fs.writeFileSync(path.join(OUT, "replies.json"), JSON.stringify(data.replies, null, 2));
  return data.replies;
}

async function replies() {
  console.log(JSON.stringify(await readReplies(), null, 2));
}

// The nightly run stays open until 1:00 AM Cairo so a reply to tonight's
// message is acted on within minutes; the hourly replies routine takes over
// after that. One call checks every minute for at most `minutes` (kept under
// the agent's 10-minute command limit) and returns as soon as a reply lands.
// Prints the replies, "no replies yet", or "reply window closed".
const REPLY_CHECK_MS = 60_000;

function replyWindowEnd() {
  // 01:00 on the current Egypt day, using the same fixed +3h as yesterdayInEgypt().
  const egyptDay = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  return Date.parse(`${egyptDay}T01:00:00Z`) - 3 * 3600_000;
}

async function wait(minutes = "8") {
  const end = replyWindowEnd();
  const stopAt = Math.min(Date.now() + Number(minutes) * 60_000, end);
  while (Date.now() < end) {
    const found = await readReplies();
    if (found.length > 0) {
      console.log(JSON.stringify(found, null, 2));
      return;
    }
    if (Date.now() + REPLY_CHECK_MS > stopAt) break;
    await new Promise((resolve) => setTimeout(resolve, REPLY_CHECK_MS));
  }
  console.log(Date.now() + REPLY_CHECK_MS > end ? "reply window closed" : "no replies yet");
}

async function apply(actionsFile) {
  if (!actionsFile) throw new Error("usage: apply <actions-json-file>");
  const res = await fetch(`${base()}/api/agent/apply`, {
    method: "POST",
    headers: { ...cronHeaders(), "content-type": "application/json" },
    body: fs.readFileSync(actionsFile, "utf8"),
  });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const commands = { sync, audit, pdf, tg, replies, wait, apply };
if (!commands[command]) {
  console.error(`unknown command "${command}" - expected one of ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
await commands[command](...args).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
