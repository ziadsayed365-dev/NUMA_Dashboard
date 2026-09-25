import "server-only";
import { supabase } from "@/lib/supabase";
import type { ShippingCourier } from "@/lib/shipping/shared";

// The courier fee model, in one place. Both the per-order margin engine
// (src/lib/engine/margin.ts) and the open-month projection
// (src/lib/reports/open-month-projection.ts) price shipments through this, so
// the two can't drift apart on what a shipment costs.
//
// NUMA ships everything through Khazenly. Its delivery fee per governorate lives
// in courier_governorate_fees as ('khazenly', governorate, fee) rows (migrations
// 0084/0085). If the sheet is ever empty every lookup returns null, and callers
// fall back to their break-even placeholder (the Shopify shipping fee charged),
// which nets Shipping Differences to zero rather than inventing a cost.
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
  actual(courier: string | null, governorate: string | null, delivered: boolean): ResolvedFee | null;
  // Fee for an order whose courier isn't known yet (Performance). With a single
  // courier this is simply Khazenly's fee; null while its sheet is missing.
  blended(governorate: string | null, delivered: boolean): ResolvedFee | null;
  mix: CourierMix;
};

export async function getCourierFees(): Promise<CourierFees> {
  const { data: feeRows, error: feeErr } = await supabase
    .from("courier_governorate_fees")
    .select("governorate, delivery_fee")
    .eq("courier", COURIER);
  if (feeErr) throw new Error(`Failed to load courier delivery fees: ${feeErr.message}`);

  const byGovernorate = new Map<string, number>();
  for (const row of feeRows ?? []) {
    if (row.delivery_fee != null) byGovernorate.set(row.governorate, Number(row.delivery_fee));
  }
  const fees = [...byGovernorate.values()].sort((a, b) => a - b);
  // An order with no governorate, or one the sheet doesn't list, costs the
  // sheet's median tier - something typical rather than nothing.
  const medianFee = fees.length > 0 ? fees[Math.floor(fees.length / 2)] : null;

  function resolve(governorate: string | null, delivered: boolean): ResolvedFee | null {
    const deliveryFee = (governorate ? byGovernorate.get(governorate) : undefined) ?? medianFee;
    if (deliveryFee === null) return null;
    return { fee: delivered ? deliveryFee : returnFeeFor(deliveryFee), bostaShare: 0 };
  }

  return {
    actual(courier, governorate, delivered) {
      if (courier !== COURIER) return null;
      return resolve(governorate, delivered);
    },
    blended(governorate, delivered) {
      return resolve(governorate, delivered);
    },
    mix: { shares: [{ courier: COURIER, share: 1 }] },
  };
}
