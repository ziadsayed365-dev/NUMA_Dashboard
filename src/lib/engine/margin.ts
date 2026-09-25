import "server-only";
import { supabase } from "@/lib/supabase";
import { normalizeGovernorate } from "@/lib/governorates";
import { fetchAllRows } from "@/lib/fetch-all";
import { getBuiltCostResolver } from "@/lib/products/final-products";
import { getCourierFees } from "@/lib/shipping/fees";
import { countsAsPlaced } from "@/lib/orders/placed";
import { daysAgo } from "@/lib/dates";

// A Sync only recomputes the orders whose margin can still move: those placed
// in the last MARGIN_WINDOW_DAYS, plus any older order changed (Khazenly outcome,
// return recorded...) in the last MARGIN_CHANGED_DAYS - every such write stamps
// orders.updated_at. Rebuilding the whole history on every Sync (and on AI NUMA's
// nightly run) grows with the store and was the costliest part of the sibling
// dashboards' Vercel CPU. Pass { fullHistory: true } for a deliberate full
// rebuild (e.g. after a cost correction that must reach old orders).
const MARGIN_WINDOW_DAYS = 60;
const MARGIN_CHANGED_DAYS = 30;

type Settings = {
  cod_cash_fee_pct: number;
  packing_cost_per_unit: number;
  refund_rate_default: number;
  damage_rate_default: number;
  default_box_size_tier: string;
  default_success_rate_estimate: number;
  bosta_open_package_fee: number;
  bosta_open_package_vat_pct: number;
};

export async function computeMargins(
  opts?: { fullHistory?: boolean }
): Promise<{ ok: boolean; lineItemsComputed: number; missingCost: number; error?: string }> {
  try {
    const { data: settingsRow, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const settings = settingsRow as Settings;

    // Flat per-shipment fee Bosta charges regardless of outcome (the
    // courier opens the package at the doorstep whether or not the
    // customer ultimately accepts it) - not in bosta_fee_matrix since it
    // doesn't vary by zone/size.
    const openPackageFeeTotal = settings.bosta_open_package_fee * (1 + settings.bosta_open_package_vat_pct);

    // Every courier's flat delivery fee per (canonical) governorate, plus the
    // trailing shipment mix that prices an order whose courier isn't known.
    const fees = await getCourierFees();

    const { data: modelRows, error: modelErr } = await supabase.from("model_groups").select("*");
    if (modelErr) throw new Error(`Failed to load model_groups: ${modelErr.message}`);
    const models = new Map(modelRows?.map((m) => [m.id, m]));

    // Laurel's cost of goods comes from the product BOM (Final Product tab),
    // not model-group costs. Single = its component build, bundle = its
    // contents roll-up, priced at the component costs in effect on each order's
    // own date (Purchasing history). Products with no BOM -> cost missing.
    const builtCost = await getBuiltCostResolver();

    // This table grows by one row per model per day, so rather than pull
    // full history, just find the most recent calibration date and use
    // that day's snapshot (bounded by model count, not history length).
    const { data: latestDateRow, error: latestDateErr } = await supabase
      .from("product_success_rates")
      .select("as_of_date")
      .order("as_of_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestDateErr) throw new Error(`Failed to find latest calibration date: ${latestDateErr.message}`);

    const latestRateByProduct = new Map<number, any>();
    if (latestDateRow) {
      const { data: rateRows, error: rateErr } = await supabase
        .from("product_success_rates")
        .select("*")
        .eq("as_of_date", latestDateRow.as_of_date);
      if (rateErr) throw new Error(`Failed to load success rates: ${rateErr.message}`);
      for (const r of rateRows ?? []) latestRateByProduct.set(r.product_id, r);
    }

    const orders = await fetchAllRows<any>(
      supabase,
      "orders",
      "id, egypt_day, total_price, cod_amount_collected, outcome, outcome_governorate, governorate_shopify, attempt_number, cancelled_at, courier, bosta_tracking_number, shipping_fee_charged, order_line_items(id, product_id, variant_id, quantity, unit_price, products(id, model_group_id, unit_cost_override))",
      opts?.fullHistory
        ? undefined
        : (query) =>
            query.or(`egypt_day.gte.${daysAgo(MARGIN_WINDOW_DAYS)},updated_at.gte.${daysAgo(MARGIN_CHANGED_DAYS)}T00:00:00Z`)
    );

    let lineItemsComputed = 0;
    let missingCost = 0;
    const updates: Array<{ id: number; values: Record<string, unknown> }> = [];

    for (const order of orders) {
      const lineItems = (order.order_line_items ?? []) as Array<{
        id: number;
        product_id: number | null;
        variant_id: number | null;
        quantity: number;
        unit_price: number;
        products: { id: number; model_group_id: number | null; unit_cost_override: number | null } | null;
      }>;
      if (lineItems.length === 0) continue;

      const totalItemsInOrder = lineItems.reduce((sum, li) => sum + li.quantity, 0);

      // Only a cancellation that beat the courier zeroes an order outright. One
      // cancelled after the parcel shipped still owes the courier's fee, and
      // zeroing it here is what used to hide that cost from the P&L entirely
      // (529 orders, ~EGP 33k across 2026) - the reports skipped the order AND
      // the columns read zero, so neither layer could recover it on its own.
      // Such an order falls through to the normal computation below, where its
      // revenue and COGS are forced to zero but its fees are priced for real.
      if (!countsAsPlaced(order)) {
        for (const li of lineItems) {
          updates.push({
            id: li.id,
            values: {
              order_id: order.id,
              quantity: li.quantity,
              unit_price: li.unit_price,
              revenue: 0,
              cost_of_goods: 0,
              allocated_courier_fee: 0,
              allocated_courier_fee_blended: 0,
              allocated_open_package_fee: 0,
              packing_cost: 0,
              refund_adjustment: 0,
              damage_adjustment: 0,
              success_rate_used: null,
              expected_margin: 0,
              realized_margin: 0,
              fee_breakdown: { reason: "order cancelled in Shopify" },
              margin_computed_at: new Date().toISOString(),
            },
          });
          lineItemsComputed++;
        }
        continue;
      }

      const governorate = normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);

      const codBasis = order.cod_amount_collected ?? order.total_price ?? 0;
      const codCashFeeTotal = codBasis * settings.cod_cash_fee_pct;

      // Two prices for the same shipment, because the two views ask different
      // questions. Actual asks "what did this order cost us", so it uses the
      // sheet of the courier that really carried it. Performance asks "what
      // does an order like this cost", so it uses every priced courier's fee
      // weighted by the trailing shipment mix - otherwise two identical days
      // would show different shipping economics purely because of which
      // courier their orders happened to be recorded to.
      //
      // Both are null while Khazenly has no price sheet (and actual is null for
      // an order nothing has shipped yet); those keep the break-even
      // placeholder below.
      const actualDelivered = fees.actual(order.courier, governorate, true);
      const actualReturned = fees.actual(order.courier, governorate, false);
      const blendedDelivered = fees.blended(governorate, true);
      const blendedReturned = fees.blended(governorate, false);
      const isUnpriced = actualDelivered === null;

      // Scales the settings' open-package and COD cash fees - Bosta-era charges,
      // 0 for Khazenly until its equivalents are known (see fees.ts).
      const actualBostaShare = actualDelivered?.bostaShare ?? 0;
      const blendedBostaShare = blendedDelivered?.bostaShare ?? 0;

      for (const li of lineItems) {
        const modelId = li.products?.model_group_id ?? null;
        const model = modelId ? models.get(modelId) : null;
        // Cost of goods = the product's built cost from its BOM (per unit), at
        // the component prices in effect on this order's date.
        const unitCost = li.product_id != null ? builtCost.at(li.product_id, li.variant_id, order.egypt_day) : null;
        const costMissing = unitCost === null;
        if (costMissing) missingCost++;

        // A shipped-then-cancelled order reaches here for its fees alone: the
        // sale did not happen, so it books no revenue and no COGS, in the P&L
        // and in the gross (100%-delivery) basis alike. Everything below -
        // courier fee, open package fee, the margin figures - is priced exactly
        // as it is for any other order with the same outcome.
        const shippedThenCancelled = Boolean(order.cancelled_at);
        const revenue = shippedThenCancelled ? 0 : li.quantity * li.unit_price;
        const costOfGoods = shippedThenCancelled ? 0 : (unitCost ?? 0) * li.quantity;
        const packing = settings.packing_cost_per_unit * li.quantity;
        const unitShare = totalItemsInOrder > 0 ? li.quantity / totalItemsInOrder : 0;
        // A courier with no price sheet still has to cost something. The
        // placeholder is the Shopify shipping fee charged, which makes its
        // Shipping Differences net to zero - not a real number, just the one
        // assumption that doesn't distort the P&L in either direction.
        const shippingFeeShare = (order.shipping_fee_charged ?? 0) * unitShare;
        const codCashFeeShare = codCashFeeTotal * unitShare * actualBostaShare;
        const openPackageFeeShare = openPackageFeeTotal * unitShare * actualBostaShare;
        const codCashFeeBlended = codCashFeeTotal * unitShare * blendedBostaShare;
        const openPackageFeeBlended = openPackageFeeTotal * unitShare * blendedBostaShare;
        const refundRate = model?.refund_rate_override ?? settings.refund_rate_default;
        const damageRate = model?.damage_rate_override ?? settings.damage_rate_default;

        // Delivered pays the governorate delivery fee; every other outcome is a
        // return (RTO/exchange/pickup) and pays Khazenly's return price.
        function feeFor(outcome: string): number {
          if (isUnpriced) return shippingFeeShare;
          const resolved = outcome === "delivered" ? actualDelivered! : actualReturned!;
          return resolved.fee * unitShare;
        }

        // The same shipment priced for Performance, whether or not it has
        // shipped yet - same placeholder while there is no sheet.
        function blendedFeeFor(outcome: string): number {
          const resolved = outcome === "delivered" ? blendedDelivered : blendedReturned;
          return resolved ? resolved.fee * unitShare : shippingFeeShare;
        }

        // "Gross" = before the refund/damage risk haircuts; these haircuts
        // are modeled as expected-value deductions, applied in full for a
        // realized outcome and probability-weighted for a projected one -
        // so every adjustment field below is reported on that same
        // consistent (always a deduction, always signed negative) basis.
        const grossDeliveredMargin = revenue - costOfGoods - feeFor("delivered") - codCashFeeShare - packing - openPackageFeeShare;
        const refundHaircut = grossDeliveredMargin * refundRate;
        const deliveredMargin = grossDeliveredMargin - refundHaircut;
        const damageHaircut = costOfGoods * damageRate;
        const failedMargin = -feeFor("failed_rto") - packing - damageHaircut - openPackageFeeShare;

        const breakdown: Record<string, unknown> = {
          governorate,
          courier: order.courier,
          unitShare,
          codBasis,
          costMissing,
          isUnpriced,
          actualDeliveryFee: actualDelivered?.fee ?? null,
          actualReturnFee: actualReturned?.fee ?? null,
          blendedDeliveryFee: blendedDelivered?.fee ?? null,
          blendedReturnFee: blendedReturned?.fee ?? null,
          courierMix: fees.mix.shares,
        };

        let expectedMargin: number;
        let realizedMargin: number | null;
        let successRateUsed: number | null = null;
        let reportedCourierFee: number;
        let reportedCourierFeeBlended: number;
        let reportedCodCashFee = 0;
        let reportedCodCashFeeBlended = 0;
        let reportedRefundAdj = 0;
        let reportedDamageAdj = 0;

        if (order.outcome === "delivered") {
          expectedMargin = deliveredMargin;
          realizedMargin = deliveredMargin;
          reportedCourierFee = feeFor("delivered");
          reportedCourierFeeBlended = blendedFeeFor("delivered");
          reportedCodCashFee = codCashFeeShare;
          reportedCodCashFeeBlended = codCashFeeBlended;
          reportedRefundAdj = -refundHaircut;
          breakdown.formula = "delivered";
        } else if (order.outcome === "failed_rto") {
          expectedMargin = failedMargin;
          realizedMargin = failedMargin;
          reportedCourierFee = feeFor("failed_rto");
          reportedCourierFeeBlended = blendedFeeFor("failed_rto");
          reportedDamageAdj = -damageHaircut;
          breakdown.formula = "failed_rto";
        } else if (order.outcome === "exchange" || order.outcome === "pickup_return") {
          const fee = feeFor(order.outcome);
          const margin = -fee - packing - damageHaircut - openPackageFeeShare;
          expectedMargin = margin;
          realizedMargin = margin;
          reportedCourierFee = fee;
          reportedCourierFeeBlended = blendedFeeFor(order.outcome);
          reportedDamageAdj = -damageHaircut;
          breakdown.formula = order.outcome;
        } else {
          // in_transit or not yet handed to Khazenly - project using the
          // calibrated success rate until the fulfillment resolves.
          const rateRow = li.product_id != null ? latestRateByProduct.get(li.product_id) : null;
          const attemptKey = !order.attempt_number || order.attempt_number <= 1 ? "1" : order.attempt_number === 2 ? "2" : "3+";
          successRateUsed = Number(rateRow?.attempt_adjusted_rates?.[attemptKey] ?? settings.default_success_rate_estimate);
          expectedMargin = successRateUsed * deliveredMargin + (1 - successRateUsed) * failedMargin;
          realizedMargin = null;
          reportedCourierFee = successRateUsed * feeFor("delivered") + (1 - successRateUsed) * feeFor("failed_rto");
          reportedCourierFeeBlended =
            successRateUsed * blendedFeeFor("delivered") + (1 - successRateUsed) * blendedFeeFor("failed_rto");
          reportedCodCashFee = successRateUsed * codCashFeeShare;
          reportedCodCashFeeBlended = successRateUsed * codCashFeeBlended;
          reportedRefundAdj = -successRateUsed * refundHaircut;
          reportedDamageAdj = -(1 - successRateUsed) * damageHaircut;
          breakdown.formula = "projected";
          breakdown.attemptKey = attemptKey;
        }

        updates.push({
          id: li.id,
          values: {
            // Postgres validates NOT NULL columns even on the ON CONFLICT
            // DO UPDATE path, so these have to be included even though
            // they never actually change here.
            order_id: order.id,
            quantity: li.quantity,
            unit_price: li.unit_price,
            revenue,
            cost_of_goods: costOfGoods,
            allocated_courier_fee: reportedCourierFee,
            allocated_open_package_fee: openPackageFeeShare,
            allocated_cod_cash_fee: reportedCodCashFee,
            // The whole Performance-view courier cost in one number, mirroring
            // the three Actual columns above outcome for outcome, so the P&L
            // can swap it in wholesale rather than recombining pieces.
            allocated_courier_fee_blended: reportedCourierFeeBlended + openPackageFeeBlended + reportedCodCashFeeBlended,
            packing_cost: packing,
            refund_adjustment: reportedRefundAdj,
            damage_adjustment: reportedDamageAdj,
            success_rate_used: successRateUsed,
            expected_margin: expectedMargin,
            realized_margin: realizedMargin,
            fee_breakdown: breakdown,
            margin_computed_at: new Date().toISOString(),
          },
        });
        lineItemsComputed++;
      }
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE).map((u) => ({ id: u.id, ...u.values }));
      const { error } = await supabase.from("order_line_items").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Failed to batch-update line items: ${error.message}`);
    }

    return { ok: true, lineItemsComputed, missingCost };
  } catch (err) {
    return { ok: false, lineItemsComputed: 0, missingCost: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}
