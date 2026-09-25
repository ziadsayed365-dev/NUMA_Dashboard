import "server-only";
import { supabase } from "@/lib/supabase";

export type AccountType = { id: number; name: string; type: "income" | "expense" };

export async function getAccountTypes(): Promise<AccountType[]> {
  const { data, error } = await supabase.from("account_types").select("id, name, type").order("name", { ascending: true });
  if (error) throw new Error(`Failed to load account_types: ${error.message}`);
  return data ?? [];
}

export type ExpenseRecord = {
  id: number;
  date: string;
  accountTypeId: number;
  accountTypeName: string;
  type: "income" | "expense";
  description: string | null;
  amount: number;
  updatedAt: string;
};

type RecordedTransactionRow = {
  id: number;
  date: string;
  account_type_id: number;
  type: "income" | "expense";
  description: string | null;
  amount: number;
  updated_at: string;
  account_types: { name: string } | null;
};

export async function getExpenseRecords(): Promise<ExpenseRecord[]> {
  const { data, error } = await supabase
    .from("recorded_transactions")
    .select("id, date, account_type_id, type, description, amount, updated_at, account_types(name)")
    .order("date", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to load recorded_transactions: ${error.message}`);

  return ((data ?? []) as unknown as RecordedTransactionRow[]).map((r) => ({
    id: r.id,
    date: r.date,
    accountTypeId: r.account_type_id,
    accountTypeName: r.account_types?.name ?? "",
    type: r.type,
    description: r.description,
    amount: Number(r.amount),
    updatedAt: r.updated_at,
  }));
}

type ExpenseRecordInput = { date: string; accountTypeId: number; description: string; amount: number };

async function resolveAccountType(accountTypeId: number): Promise<"income" | "expense"> {
  const { data: accountType, error } = await supabase.from("account_types").select("id, type").eq("id", accountTypeId).single();
  if (error || !accountType) throw new Error("Invalid account type");
  return accountType.type;
}

export async function createExpenseRecord(input: ExpenseRecordInput): Promise<number> {
  if (!(input.amount > 0)) throw new Error("Amount must be positive");
  const type = await resolveAccountType(input.accountTypeId);

  const { data, error } = await supabase
    .from("recorded_transactions")
    .insert({
      date: input.date,
      account_type_id: input.accountTypeId,
      type,
      description: input.description || null,
      amount: input.amount,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create record: ${error?.message}`);
  return data.id;
}

export async function updateExpenseRecord(id: number, input: ExpenseRecordInput): Promise<void> {
  if (!(input.amount > 0)) throw new Error("Amount must be positive");
  const type = await resolveAccountType(input.accountTypeId);

  const { error } = await supabase
    .from("recorded_transactions")
    .update({
      date: input.date,
      account_type_id: input.accountTypeId,
      type,
      description: input.description || null,
      amount: input.amount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to update record: ${error.message}`);
}

export async function deleteExpenseRecords(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from("recorded_transactions").delete().in("id", ids);
  if (error) throw new Error(`Failed to delete records: ${error.message}`);
}

// The cutoff the Report tab filters against - only entries last touched
// at or before this timestamp are reflected, so new/edited entries wait
// for the next Sync rather than shifting the report mid-review.
export async function getRecordDataSyncedAt(): Promise<string | null> {
  const { data, error } = await supabase.from("settings").select("record_data_synced_at").eq("id", 1).single();
  if (error) throw new Error(`Failed to load settings: ${error.message}`);
  return data?.record_data_synced_at ?? null;
}

export async function markRecordDataSynced(): Promise<void> {
  const { error } = await supabase
    .from("settings")
    .update({ record_data_synced_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`Failed to update settings: ${error.message}`);
}
