import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday, firstOfMonth, firstOfNextMonth } from "@/lib/dates";
import { RETURNED_OUTCOMES } from "@/lib/shipping/shared";
import { getProductDailyRollforward } from "@/lib/reports/per-product";
import {
  addMonths,
  daysBetween,
  subscriptionStatus,
  type Subscriber,
  type SubscriptionDashboard,
  type SubscriptionMonth,
  type SubscriptionOrder,
} from "./shared";

// A subscription line is any line of a product whose name says "subscription" -
// today "numa Focus - Monthly Subscription", plus the older "Monthly
// subscription 10 Numa pockets" it replaced. product_title_raw covers a line
// whose product was deleted from Shopify (it keeps only its title).
const SUBSCRIPTION_PATTERN = "%subscription%";

// Month by month from the first subscription order to today. Revenue, COGS and
// order counts come from the same paid orders as the customer list; marketing is
// the Subscription product's daily ad spend from the product Rollforward, summed
// per month, so this and Analysis by Product can never disagree.
async function getSubscriptionMonths(subscribers: Subscriber[], productIds: number[], today: string): Promise<SubscriptionMonth[]> {
  const firstDay = subscribers.reduce((min, s) => (s.since < min ? s.since : min), today);
  const byMonth = new Map<string, SubscriptionMonth>();
  for (let m = firstOfMonth(firstDay); m <= today; m = firstOfNextMonth(m)) {
    byMonth.set(m, { month: m, orders: 0, revenue: 0, cogs: 0, marketing: 0 });
  }
  for (const s of subscribers) {
    for (const o of s.orders) {
      const m = byMonth.get(firstOfMonth(o.day));
      if (!m) continue;
      m.orders++;
      m.revenue += o.revenue;
      m.cogs += o.cogs;
    }
  }
  const rollforwards = await Promise.all(
    productIds.map((id) => getProductDailyRollforward(id, firstOfMonth(firstDay), today, "performance"))
  );
  for (const rf of rollforwards) {
    for (const row of rf.rows) {
      const m = byMonth.get(firstOfMonth(row.date));
      if (m) m.marketing += row.adSpend;
    }
  }
  return [...byMonth.values()];
}

type LineRow = {
  order_id: number;
  quantity: number;
  unit_price: number;
  cost_of_goods: number | null;
};

type OrderRow = {
  id: number;
  order_number: string;
  egypt_day: string;
  cancelled_at: string | null;
  outcome: string | null;
  bosta_tracking_number: string | null;
  customer_shopify_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
};

export async function getSubscriptionDashboard(): Promise<SubscriptionDashboard> {
  const today = egyptToday();

  const { data: products, error: prodErr } = await supabase
    .from("products")
    .select("id")
    .ilike("name", SUBSCRIPTION_PATTERN);
  if (prodErr) throw new Error(`Failed to load subscription products: ${prodErr.message}`);
  const productIds = (products ?? []).map((p) => p.id as number);

  const lineFilter = [`product_title_raw.ilike.${SUBSCRIPTION_PATTERN.replaceAll("%", "*")}`];
  if (productIds.length > 0) lineFilter.unshift(`product_id.in.(${productIds.join(",")})`);
  const lines = await fetchAllRows<LineRow>(supabase, "order_line_items", "id, order_id, quantity, unit_price, cost_of_goods", (q) =>
    q.or(lineFilter.join(","))
  );

  const byOrder = new Map<number, { revenue: number; cogs: number }>();
  for (const li of lines) {
    const acc = byOrder.get(li.order_id) ?? { revenue: 0, cogs: 0 };
    // Only the subscription lines count - an order can carry other products too.
    acc.revenue += Number(li.quantity) * Number(li.unit_price);
    acc.cogs += Number(li.cost_of_goods ?? 0);
    byOrder.set(li.order_id, acc);
  }

  const orderIds = [...byOrder.keys()];
  const orders: OrderRow[] = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, order_number, egypt_day, cancelled_at, outcome, bosta_tracking_number, customer_shopify_id, customer_name, customer_phone")
      .in("id", orderIds.slice(i, i + 200));
    if (error) throw new Error(`Failed to load subscription orders: ${error.message}`);
    orders.push(...((data ?? []) as OrderRow[]));
  }

  // One entry per customer. A cancelled or returned order was never a paid
  // month, so it neither counts nor moves the renewal date.
  const byCustomer = new Map<string, { rows: OrderRow[] }>();
  for (const o of orders) {
    if (o.cancelled_at) continue;
    if (RETURNED_OUTCOMES.includes(o.outcome ?? "")) continue;
    const key = o.customer_shopify_id ?? o.customer_phone ?? o.order_number;
    const entry = byCustomer.get(key) ?? { rows: [] };
    entry.rows.push(o);
    byCustomer.set(key, entry);
  }

  const subscribers: Subscriber[] = [];
  for (const [key, { rows }] of byCustomer) {
    rows.sort((a, b) => (a.egypt_day === b.egypt_day ? b.id - a.id : a.egypt_day < b.egypt_day ? 1 : -1)); // newest first
    const subOrders: SubscriptionOrder[] = rows.map((o) => ({
      orderNumber: o.order_number,
      day: o.egypt_day,
      revenue: byOrder.get(o.id)?.revenue ?? 0,
      cogs: byOrder.get(o.id)?.cogs ?? 0,
    }));
    const latest = rows[0];
    const nextRenewal = addMonths(latest.egypt_day, 1);
    const daysToRenewal = daysBetween(today, nextRenewal);
    subscribers.push({
      key,
      // The newest order carries the most current name / phone.
      name: rows.find((o) => o.customer_name)?.customer_name ?? null,
      phone: rows.find((o) => o.customer_phone)?.customer_phone ?? null,
      since: rows[rows.length - 1].egypt_day,
      monthsPaid: rows.length,
      lastOrder: subOrders[0],
      nextRenewal,
      daysToRenewal,
      status: subscriptionStatus(daysToRenewal),
      revenue: subOrders.reduce((s, o) => s + o.revenue, 0),
      cogs: subOrders.reduce((s, o) => s + o.cogs, 0),
      orders: subOrders,
    });
  }

  // Most urgent first: whoever is furthest past (or closest to) their renewal.
  subscribers.sort((a, b) => a.daysToRenewal - b.daysToRenewal);

  const revenue = subscribers.reduce((s, c) => s + c.revenue, 0);
  const cogs = subscribers.reduce((s, c) => s + c.cogs, 0);
  const grossProfit = revenue - cogs;
  const months = await getSubscriptionMonths(subscribers, productIds, today);
  return {
    today,
    subscribers,
    totals: {
      customers: subscribers.length,
      active: subscribers.filter((s) => s.status !== "overdue").length,
      revenue,
      cogs,
      grossProfit,
      grossMargin: revenue > 0 ? grossProfit / revenue : null,
    },
    months,
  };
}
