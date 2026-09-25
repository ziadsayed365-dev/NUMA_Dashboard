@AGENTS.md

---

# NUMA

Financial/operations dashboard for the **NUMA** business, copied from the Laurel dashboard
(itself forked from the finvisor-dashboard / IZAR codebase). Next.js 16 + Supabase, with
Shopify (products/orders + courier status) and Meta (ad spend) integrations feeding a
P&L / margin engine.

## Courier: Khazenly only (Launder-style)
- No courier API. Khazenly writes each parcel's status onto the **Shopify fulfillment**
  (DELIVERED / NOT_DELIVERED / OUT_FOR_DELIVERY ..., tracking `KH-NUMA-...`), and the Shopify
  order sync (`src/lib/sync/shopify-orders.ts`, `classifyShipment`) sets `courier='khazenly'`,
  the ship day, tracking number and outcome from it.
- **Returns are uploaded by hand** (Shipping Orders > Record Returns). That stamps
  `orders.return_recorded_at`, and while it's set the Shopify sync never touches the outcome.
- Inherited column names are kept: `bosta_picked_up_day` = Khazenly fulfillment day,
  `bosta_tracking_number` = Khazenly tracking number, `bostaPenalty` = return penalty
  (migration 0076). `movers_record_date` is unused.
- Fees: `courier_governorate_fees` rows for `'khazenly'` (migrations 0084/0085, 92-154 EGP per
  governorate; Helwan and 6th of October are priced separately from Cairo / Giza). A return costs the
  full delivery fee again, and Khazenly charges no COD / open-package fee - both confirmed by the owner
  (`src/lib/shipping/fees.ts`).

## Ad spend split (owner's rule, `splitSharedAdSpend` in `src/lib/reports/per-product.ts`)
- An ad is pinned to one product, several ticked products (`ad_assignments.product_ids`), or General.
- Shared spend (General / several products) is split **equally every day, whether or not a product
  sold** - General across every ACTIVE product, a multi-product ad across its ticked products.
- **Exception: the Subscription product** ("numa Focus - Monthly Subscription", matched by name) only
  takes a share on days a subscription order was placed; otherwise it's left out of that day's split.

## AI NUMA (nightly auditor, same design as AI OGARAGE / AI MIRAJ)
- Instructions: `scripts/ai-numa/AGENT.md` (nightly, 12:10 AM Cairo) and `REPLIES.md` (hourly 1:10 AM-12:10 PM);
  tools: `scripts/ai-numa/numa.mjs` (no install). Needs `NUMA_URL` + `NUMA_CRON_SECRET` in the cloud run.
- Dashboard side, all behind `CRON_SECRET`: `/api/agent/audit` (`src/lib/reports/nightly-audit.ts`),
  `/api/agent/apply` (`src/lib/agent/actions.ts` - TikTok spend + ad allocation only, never overwrites),
  `/api/agent/telegram` (needs `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), `/api/agent/pdf` (headless Chromium,
  `src/lib/report-pdf.ts`; `APP_URL` optional). `/api/sync/run` also accepts `CRON_SECRET`.
- No "set cost" action: NUMA's cost is a BOM, so missing costs are reported, never fixed from Telegram.
- Audit only flags data from `AUDIT_SINCE` (2026-09-25) on.

## NUMA-specific notes
- Code comments that mention "Laurel" describe behavior inherited from the Laurel setup
  (e.g. Bosta order number in `notes`, per-product ad allocation, BOM-based COGS). Verify each
  against NUMA's real data before relying on it.
- `public/dark-logo.jpeg` is still Laurel's logo - replace with NUMA's.
- Account types (migration 0044) and inventory groups (0063/0064) were seeded for Laurel;
  review before running migrations on NUMA's Supabase project.