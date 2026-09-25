// Client-safe Subscription types and rules - no server-only / supabase imports,
// so the Subscription page's client table can use them. Data access lives in
// ./subscriptions.ts (server-only).
//
// NUMA sells a monthly subscription ("numa Focus - Monthly Subscription": 10 numa
// Focus a month, free shipping). The customer buys it once on the site; every
// month after that the owner creates a new Shopify order for them and sends a
// Paymob link. So each subscription ORDER is one paid month, and a customer's
// renewals are simply their subscription orders over time.

export type SubscriptionStatus = "active" | "due_soon" | "late" | "overdue";

// Days before the renewal date a customer shows as "due soon".
export const DUE_SOON_DAYS = 7;
// Days after the renewal date before a missing order counts as "didn't order".
export const GRACE_DAYS = 3;

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "Active",
  due_soon: "Due soon",
  late: "Late",
  overdue: "Overdue – didn't order",
};

export type SubscriptionOrder = {
  orderNumber: string;
  day: string; // Egypt day the order was placed
  revenue: number; // the subscription lines only, net of discounts
  cogs: number;
};

export type Subscriber = {
  key: string; // Shopify customer id, else phone, else the order number
  name: string | null;
  phone: string | null;
  since: string; // first subscription order day
  monthsPaid: number; // subscription orders that weren't cancelled or returned
  lastOrder: SubscriptionOrder;
  nextRenewal: string; // last order day + 1 month
  daysToRenewal: number; // negative = past due
  status: SubscriptionStatus;
  revenue: number;
  cogs: number;
  orders: SubscriptionOrder[]; // newest first
};

export type SubscriptionDashboard = {
  today: string;
  subscribers: Subscriber[];
  totals: {
    customers: number;
    active: number; // not overdue
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMargin: number | null; // gross profit / revenue, null with no revenue
  };
  // One entry per calendar month from the first subscription order to today,
  // oldest first - the Subscription P&L pages through these like the product
  // Rollforward pages through days.
  months: SubscriptionMonth[];
};

export type SubscriptionMonth = {
  month: string; // "YYYY-MM-01"
  orders: number; // paid subscription orders placed that month
  revenue: number;
  cogs: number;
  // Ads charged to the Subscription product that month, split exactly as the
  // product Rollforward splits them (its own ads + its share of General /
  // multi-product ads).
  marketing: number;
};

// Calendar-month step that clamps to the month's last day: 31 Jan + 1 month =
// 28/29 Feb, never 2/3 Mar.
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

// Where a customer stands against their next renewal date.
export function subscriptionStatus(daysToRenewal: number): SubscriptionStatus {
  if (daysToRenewal > DUE_SOON_DAYS) return "active";
  if (daysToRenewal >= 0) return "due_soon";
  if (daysToRenewal >= -GRACE_DAYS) return "late";
  return "overdue";
}
