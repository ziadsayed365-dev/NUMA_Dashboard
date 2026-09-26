import "server-only";
import { supabase } from "@/lib/supabase";
import type { ShippingCourier } from "@/lib/shipping/shared";

// The courier fee model, in one place. Both the per-order margin engine
// (src/lib/engine/margin.ts) and the open-month projection
// (src/lib/reports/open-month-projection.ts) price shipments through this, so
// the two can't drift apart on what a shipment costs.
//
// NUMA ships everything through Khazenly. Its delivery fee per governorate lives
// in courier_governorate_fees as ('khazenly', governorate, effective_from, fee)
// rows (migrations 0084-0086). A shipment is priced on the sheet in effect on its
// day - the Khazenly fulfillment day, or the order day before it ships - so a
// price change never reprices earlier months. If no sheet covers the day every
// lookup returns null, and callers fall back to their break-even placeholder
// (the Shopify shipping fee charged), which nets Shipping Differences to zero
// rather than inventing a cost.
const COURIER: ShippingCourier = "khazenly";

// A return costs the full delivery fee - Khazenly charges the whole shipping fee
// again for a parcel that comes back (confirmed by the owner).
function returnFeeFor(deliveryFee: number): number {
  return deliveryFee;
}

export type ResolvedFee = {
  fee: number; // whole-order courier fee for this outcome (callers apply each line's unitShare)
  // Multiplier for the settings' open-package and COD cash fees. Those were
  // Bosta charges; Khazenly charges neither (confirmed by the owner), so it is 0.
  bostaShare: number;
};

export type CourierMix = {
  shares: { courier: string; share: number }[];
};

export type CourierFees = {
  // Fee for the courier that actually shipped the order, or null when it has no
  // price sheet or nothing shipped it - the caller decides what that costs.
  // `day` (YYYY-MM-DD) picks the price sheet in effect.
  actual(courier: string | null, governorate: string | null, delivered: boolean, day: string): ResolvedFee | null;
  // Fee for an order whose courier isn't known yet (Performance). With a single
  // courier this is simply Khazenly's fee; null while its sheet is missing.
  blended(governorate: string | null, delivered: boolean, day: string): ResolvedFee | null;
  mix: CourierMix;
};

type Sheet = { from: string; byGovernorate: Map<string, number>; medianFee: number | null };

export async function getCourierFees(): Promise<CourierFees> {
  const { data: feeRows, error: feeErr } = await supabase
    .from("courier_governorate_fees")
    .select("governorate, effective_from, delivery_fee")
    .eq("courier", COURIER);
  if (feeErr) throw new Error(`Failed to load courier delivery fees: ${feeErr.message}`);

  const byEffectiveFrom = new Map<string, Map<string, number>>();
  for (const row of feeRows ?? []) {
    if (row.delivery_fee == null) continue;
    if (!byEffectiveFrom.has(row.effective_from)) byEffectiveFrom.set(row.effective_from, new Map());
    byEffectiveFrom.get(row.effective_from)!.set(row.governorate, Number(row.delivery_fee));
  }
  // Newest first, so the first sheet starting on or before a day is the one in effect.
  const sheets: Sheet[] = [...byEffectiveFrom.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([from, byGovernorate]) => {
      const fees = [...byGovernorate.values()].sort((a, b) => a - b);
      // An order with no governorate, or one the sheet doesn't list, costs the
      // sheet's median tier - something typical rather than nothing.
      return { from, byGovernorate, medianFee: fees.length > 0 ? fees[Math.floor(fees.length / 2)] : null };
    });

  function resolve(governorate: string | null, delivered: boolean, day: string): ResolvedFee | null {
    const sheet = sheets.find((s) => s.from <= day);
    if (!sheet) return null;
    const deliveryFee = (governorate ? sheet.byGovernorate.get(governorate) : undefined) ?? sheet.medianFee;
    if (deliveryFee === null) return null;
    return { fee: delivered ? deliveryFee : returnFeeFor(deliveryFee), bostaShare: 0 };
  }

  return {
    actual(courier, governorate, delivered, day) {
      if (courier !== COURIER) return null;
      return resolve(governorate, delivered, day);
    },
    blended(governorate, delivered, day) {
      return resolve(governorate, delivered, day);
    },
    mix: { shares: [{ courier: COURIER, share: 1 }] },
  };
}
