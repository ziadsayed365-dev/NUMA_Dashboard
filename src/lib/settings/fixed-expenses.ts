import "server-only";
import { supabase } from "@/lib/supabase";
import { firstOfMonth } from "@/lib/dates";
import {
  PERF_EXPENSE_ACCOUNTS,
  PERF_EXPENSE_SLUGS,
  emptyPerfExpenseHistory,
  type PerfExpenseHistory,
  type RecordedExpensesByMonth,
} from "./perf-expenses";

// Server-side reads/writes for the effective-dated Performance fixed expenses.
// Types, account metadata and the per-month resolver are client-safe and live
// in ./perf-expenses (shared with the P&L tables).
export type {
  PerfFixedExpenses,
  PerfExpenseKey,
  PerfExpenseEntry,
  PerfExpenseHistory,
} from "./perf-expenses";
export { PERF_EXPENSE_ACCOUNTS } from "./perf-expenses";

const SLUG_TO_KEY = new Map(PERF_EXPENSE_ACCOUNTS.map((a) => [a.slug, a.key]));
// The Expenses & Income tab records against account_types by NAME; each expense
// account's name matches a P&L expense account's label, so recorded actuals map
// onto the same P&L lines.
const NAME_TO_KEY = new Map(PERF_EXPENSE_ACCOUNTS.map((a) => [a.label, a.key]));

// Actual recorded amounts summed per month per P&L account, from the Expenses &
// Income tab. A closed month shows these instead of the Settings average. Amounts
// are stored positive; the P&L applies each account's sign by nature (Other-Income
// adds, expenses subtract). Any account not in PERF_EXPENSE_ACCOUNTS (e.g. Bosta,
// Quick Box, Turbo) is ignored - it's tracked in the tab but not shown in the P&L.
export async function getRecordedExpensesByMonth(): Promise<RecordedExpensesByMonth> {
  const { data, error } = await supabase
    .from("recorded_transactions")
    .select("date, amount, account_types(name)");
  if (error) throw new Error(`Failed to load recorded amounts: ${error.message}`);

  const byMonth: RecordedExpensesByMonth = {};
  for (const row of (data ?? []) as unknown as { date: string; amount: number; account_types: { name: string } | null }[]) {
    const key = row.account_types?.name ? NAME_TO_KEY.get(row.account_types.name) : undefined;
    if (!key) continue;
    const month = firstOfMonth(row.date);
    const bucket = (byMonth[month] ??= {});
    bucket[key] = (bucket[key] ?? 0) + Number(row.amount);
  }
  return byMonth;
}

// The full timeline for every account, each sorted ascending by month.
export async function getPerfExpenseHistory(): Promise<PerfExpenseHistory> {
  const { data, error } = await supabase
    .from("perf_fixed_expenses")
    .select("account, effective_month, amount")
    .order("effective_month", { ascending: true });
  if (error) throw new Error(`Failed to load fixed expenses: ${error.message}`);

  const history = emptyPerfExpenseHistory();
  for (const row of (data ?? []) as { account: string; effective_month: string; amount: number }[]) {
    const key = SLUG_TO_KEY.get(row.account);
    if (!key) continue;
    history[key].push({ month: firstOfMonth(row.effective_month), amount: Number(row.amount) });
  }
  return history;
}

// Add or update an account's amount effective from a given month. `month` may be
// any date within the target month; it is normalised to the first of the month
// so there is one entry per (account, month).
export async function upsertPerfExpenseEntry(slug: string, month: string, amount: number): Promise<void> {
  if (!PERF_EXPENSE_SLUGS.includes(slug)) throw new Error("Unknown expense account");
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Amount must be zero or a positive number");
  const effectiveMonth = firstOfMonth(month);
  if (!/^\d{4}-\d{2}-01$/.test(effectiveMonth)) throw new Error("Invalid effective month");

  const { error } = await supabase
    .from("perf_fixed_expenses")
    .upsert(
      { account: slug, effective_month: effectiveMonth, amount, updated_at: new Date().toISOString() },
      { onConflict: "account,effective_month" }
    );
  if (error) throw new Error(`Failed to save fixed expense: ${error.message}`);
}

export async function deletePerfExpenseEntry(slug: string, month: string): Promise<void> {
  if (!PERF_EXPENSE_SLUGS.includes(slug)) throw new Error("Unknown expense account");
  const effectiveMonth = firstOfMonth(month);
  const { error } = await supabase
    .from("perf_fixed_expenses")
    .delete()
    .eq("account", slug)
    .eq("effective_month", effectiveMonth);
  if (error) throw new Error(`Failed to remove fixed expense: ${error.message}`);
}
