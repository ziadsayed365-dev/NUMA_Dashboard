import "server-only";
import { supabase } from "@/lib/supabase";
import { firstOfMonth } from "@/lib/dates";

export type FixedAsset = {
  id: number;
  name: string;
  purchaseDate: string;
  amount: number;
  usefulLifeYears: number;
};

export async function getFixedAssets(): Promise<FixedAsset[]> {
  const { data, error } = await supabase
    .from("fixed_assets")
    .select("id, name, purchase_date, amount, useful_life_years")
    .order("purchase_date", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to load fixed assets: ${error.message}`);
  return (data ?? []).map((a) => ({
    id: a.id as number,
    name: a.name as string,
    purchaseDate: a.purchase_date as string,
    amount: Number(a.amount),
    usefulLifeYears: Number(a.useful_life_years),
  }));
}

export async function createFixedAsset(input: {
  name: string;
  purchaseDate: string;
  amount: number;
  usefulLifeYears: number;
}): Promise<number> {
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate)) throw new Error("Invalid purchase date");
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error("Amount must be zero or a positive number");
  if (!Number.isFinite(input.usefulLifeYears) || input.usefulLifeYears <= 0) throw new Error("Useful life must be positive");

  const { data, error } = await supabase
    .from("fixed_assets")
    .insert({ name, purchase_date: input.purchaseDate, amount: input.amount, useful_life_years: input.usefulLifeYears })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to save asset: ${error?.message}`);
  return data.id;
}

export async function deleteFixedAsset(id: number): Promise<void> {
  const { error } = await supabase.from("fixed_assets").delete().eq("id", id);
  if (error) throw new Error(`Failed to remove asset: ${error.message}`);
}

// The month after `monthStart` ("YYYY-MM-01").
function nextMonth(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

// Total straight-line depreciation per calendar month across every asset. Each
// asset contributes amount / (useful_life_years * 12) each month, from its
// purchase month, for that many months, then stops.
export async function getDepreciationByMonth(): Promise<Record<string, number>> {
  const { data, error } = await supabase.from("fixed_assets").select("purchase_date, amount, useful_life_years");
  if (error) throw new Error(`Failed to load fixed assets: ${error.message}`);

  const byMonth: Record<string, number> = {};
  for (const a of (data ?? []) as { purchase_date: string; amount: number; useful_life_years: number }[]) {
    const months = Math.round(Number(a.useful_life_years) * 12);
    if (months <= 0) continue;
    const monthly = Number(a.amount) / months;
    let m = firstOfMonth(a.purchase_date);
    for (let i = 0; i < months; i++) {
      byMonth[m] = (byMonth[m] ?? 0) + monthly;
      m = nextMonth(m);
    }
  }
  return byMonth;
}
