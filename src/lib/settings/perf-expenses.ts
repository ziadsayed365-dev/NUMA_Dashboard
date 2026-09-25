import { firstOfMonth } from "@/lib/dates";

// Performance-tab fixed expenses. Each account (Salaries, Rent, …) is
// effective-dated: an amount takes effect from a given month and holds until a
// later effective row supersedes it. The Performance Income Statement resolves,
// per month, the newest amount whose effective month is <= that month — so
// editing an amount only affects months on or after its effective month and
// leaves earlier months untouched.
//
// This module is client-safe (no server-only DB access) so both the P&L tables
// (which resolve amounts per column) and the server lib can share the types,
// account metadata, and resolver. DB reads/writes live in ./fixed-expenses.

export type PerfFixedExpenses = {
  salaries: number;
  postProduction: number;
  subscription: number;
  rent: number;
  transportation: number;
  packingFees: number;
  khazenlyStorage: number;
  otherExpense: number;
};

export type PerfExpenseKey = keyof PerfFixedExpenses;

// A single point in an account's timeline. `month` is always the first day of
// the month it takes effect, as an ISO "YYYY-MM-01" string.
export type PerfExpenseEntry = { month: string; amount: number };

// Every account's timeline, each sorted ascending by month.
export type PerfExpenseHistory = Record<PerfExpenseKey, PerfExpenseEntry[]>;

// Actual recorded expense totals, keyed by month ("YYYY-MM-01") then account key.
// A closed month in the P&L shows these real figures instead of the Settings
// average (missing accounts read 0). Rolled up from recorded_transactions.
export type RecordedExpensesByMonth = Record<string, Partial<Record<PerfExpenseKey, number>>>;

// Account metadata: the in-code key, its display label, and the stable slug
// stored in the perf_fixed_expenses.account column. `nature` sets the P&L sign
// (income adds to Net Profit, expense subtracts); `section` places the row -
// "fixed" accounts sit above Shipping Differences, "other" accounts below Return
// Penalty. Order drives both the P&L rows and the Settings editor.
export const PERF_EXPENSE_ACCOUNTS: {
  key: PerfExpenseKey;
  label: string;
  slug: string;
  nature: "income" | "expense";
  section: "fixed" | "other";
}[] = [
  { key: "salaries", label: "Salaries", slug: "salaries", nature: "expense", section: "fixed" },
  { key: "postProduction", label: "Post Production", slug: "post_production", nature: "expense", section: "fixed" },
  { key: "subscription", label: "Subscription", slug: "subscription", nature: "expense", section: "fixed" },
  { key: "rent", label: "Rent", slug: "rent", nature: "expense", section: "fixed" },
  { key: "transportation", label: "Transportation", slug: "transportation", nature: "expense", section: "fixed" },
  { key: "packingFees", label: "Packing fees", slug: "packing_fees", nature: "expense", section: "fixed" },
  // Label must stay exactly equal to the account_types name (migration 0083) -
  // that string match is what carries recorded amounts onto this P&L line.
  { key: "khazenlyStorage", label: "Khazenly Storage Fees", slug: "khazenly_storage_fees", nature: "expense", section: "fixed" },
  { key: "otherExpense", label: "Other-Expense", slug: "other_expense", nature: "expense", section: "other" },
];

export const PERF_EXPENSE_SLUGS = PERF_EXPENSE_ACCOUNTS.map((a) => a.slug);

export function emptyPerfExpenseHistory(): PerfExpenseHistory {
  return {
    salaries: [],
    postProduction: [],
    subscription: [],
    rent: [],
    transportation: [],
    packingFees: [],
    khazenlyStorage: [],
    otherExpense: [],
  };
}

export const ZERO_PERF_EXPENSES: PerfFixedExpenses = {
  salaries: 0,
  postProduction: 0,
  subscription: 0,
  rent: 0,
  transportation: 0,
  packingFees: 0,
  khazenlyStorage: 0,
  otherExpense: 0,
};

// The amount in effect for a given month = the newest entry whose effective
// month is on or before it. Entries are assumed sorted ascending; months share
// the "YYYY-MM-01" format so a plain string compare orders them correctly.
// No entry on or before the month means the account was not yet set → 0.
function pickForMonth(series: PerfExpenseEntry[], targetMonth: string): number {
  let amount = 0;
  for (const entry of series) {
    if (entry.month <= targetMonth) amount = entry.amount;
    else break;
  }
  return amount;
}

// Resolve all accounts for the month containing `dateISO` (a day or month date).
export function resolvePerfExpensesForMonth(history: PerfExpenseHistory, dateISO: string): PerfFixedExpenses {
  const target = firstOfMonth(dateISO);
  return {
    salaries: pickForMonth(history.salaries, target),
    postProduction: pickForMonth(history.postProduction, target),
    subscription: pickForMonth(history.subscription, target),
    rent: pickForMonth(history.rent, target),
    transportation: pickForMonth(history.transportation, target),
    packingFees: pickForMonth(history.packingFees, target),
    khazenlyStorage: pickForMonth(history.khazenlyStorage, target),
    otherExpense: pickForMonth(history.otherExpense, target),
  };
}
