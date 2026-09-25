"use client";

import type { ShippingAnalysisRow } from "@/lib/shipping/analysis";
import { courierLabel } from "@/lib/shipping/shared";
import type {
  BusinessMonthlyRate,
  DeliveryRatesResult,
  MonthlyRate,
  ProductMonthlyRate,
} from "@/lib/shipping/shared";

function fmtMonthShort(month: string): string {
  // month is "YYYY-MM"; anchor at UTC so it can't roll back to the prior month.
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function int(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

// Green once most orders land, amber in the middle, red when returns dominate.
function rateColor(rate: number | null): string {
  if (rate === null) return "text-gray-400";
  if (rate >= 0.9) return "text-green-700";
  if (rate >= 0.75) return "text-amber-700";
  return "text-red-700";
}

export function ShippingAnalysisTab({
  rows,
  rates,
  productRates,
}: {
  rows: ShippingAnalysisRow[];
  rates: DeliveryRatesResult;
  productRates: ProductMonthlyRate[];
}) {
  const totals = rows.reduce(
    (acc, r) => ({
      shipped: acc.shipped + r.shipped,
      delivered: acc.delivered + r.delivered,
      returned: acc.returned + r.returned,
      inTransit: acc.inTransit + r.inTransit,
    }),
    { shipped: 0, delivered: 0, returned: 0, inTransit: 0 }
  );
  const totalResolved = totals.delivered + totals.returned;
  const totalRate = totalResolved > 0 ? totals.delivered / totalResolved : null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        Every shipped order, by who shipped it. Delivery rate is delivered ÷ resolved (delivered + returned) — parcels still
        on the road are left out.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card label="Shipped" value={int(totals.shipped)} />
        <Card label="Delivered" value={int(totals.delivered)} />
        <Card label="Returned" value={int(totals.returned)} />
        <Card label="Overall delivery rate" value={pct(totalRate)} color={rateColor(totalRate)} />
      </div>

      <DeliveryRateTable rates={rates} productRates={productRates} />
    </div>
  );
}

// Download the orders behind a cell. A plain link rather than a fetch: the
// route replies with a file attachment, so the browser handles the save itself.
function exportHref(month: string, scope: { courier?: string; productId?: number }): string {
  const params = new URLSearchParams({ month });
  if (scope.courier) params.set("courier", scope.courier);
  if (scope.productId != null) params.set("productId", String(scope.productId));
  return `/api/shipping/analysis/export?${params.toString()}`;
}

function cellTitle(cell: { shipped: number; delivered: number } | undefined): string {
  return cell ? `${cell.delivered} delivered / ${cell.shipped} shipped` : "";
}

// Delivery rate by the month each order was PLACED, as a month-per-column
// matrix: the whole business, all couriers, each courier, then each product.
// Every rate is a link that downloads the orders it was computed from.
function DeliveryRateTable({ rates, productRates }: { rates: DeliveryRatesResult; productRates: ProductMonthlyRate[] }) {
  const { months, overallBusiness, overall, byCourier } = rates;
  const overallByMonth = new Map(overall.map((m) => [m.month, m] as const));
  const businessByMonth = new Map(overallBusiness.map((m) => [m.month, m] as const));

  if (months.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No orders recorded as shipped yet.</div>;
  }

  const rateCell = (
    key: string,
    cell: { shipped: number; delivered: number; rate: number | null } | undefined,
    dense = false,
    scope?: { courier?: string; productId?: number }
  ) => (
    <td key={key} className={`px-3 ${dense ? "py-1.5" : "py-2"} text-right ${rateColor(cell?.rate ?? null)}`} title={cellTitle(cell)}>
      {/* Clickable on shipped, not on rate: a cell showing "—" because nothing
          has settled yet is exactly the one worth downloading and chasing. */}
      {cell && cell.shipped > 0 && scope ? (
        <a
          href={exportHref(key, scope)}
          className="underline decoration-dotted underline-offset-2 hover:opacity-70"
          title={`${cellTitle(cell)} — click to download`}
        >
          {pct(cell.rate)}
        </a>
      ) : (
        pct(cell?.rate ?? null)
      )}
    </td>
  );

  // The rate cell plus, underneath, how many of that month's orders are still
  // unconfirmed. Only the courier rows get one: a product row is a line-item
  // aggregate with no outcome of its own.
  const rateCellWithOpen = (key: string, cell: MonthlyRate | undefined, dense = false, scope?: { courier?: string }) => {
    const open = cell?.inProgress ?? 0;
    const clickable = cell && cell.shipped > 0 && scope;
    return (
      <td
        key={key}
        className={`px-3 ${dense ? "py-1.5" : "py-2"} text-right align-top`}
        title={cell ? `${cellTitle(cell)}${open > 0 ? ` · ${open} still in progress` : ""}${clickable ? " — click to download" : ""}` : ""}
      >
        {clickable ? (
          <a
            href={exportHref(key, scope)}
            className={`${rateColor(cell.rate)} block underline decoration-dotted underline-offset-2 hover:opacity-70`}
          >
            {pct(cell.rate)}
          </a>
        ) : (
          <div className={rateColor(cell?.rate ?? null)}>{pct(cell?.rate ?? null)}</div>
        )}
        {open > 0 && <div className="text-[10px] font-normal text-amber-600">{int(open)} open</div>}
      </td>
    );
  };

  // Whole-business cell: the denominator is every order that came in, so it
  // carries `received` rather than `shipped`. Exports the same file the
  // all-couriers row does - that file already lists never-shipped orders.
  const businessCell = (key: string, cell: BusinessMonthlyRate | undefined) => (
    <td
      key={key}
      className={`px-3 py-2 text-right ${rateColor(cell?.rate ?? null)}`}
      title={cell ? `${cell.delivered} delivered / ${cell.received} orders placed — click to download` : ""}
    >
      {cell && cell.rate !== null ? (
        <a href={exportHref(key, {})} className="underline decoration-dotted underline-offset-2 hover:opacity-70">
          {pct(cell.rate)}
        </a>
      ) : (
        pct(cell?.rate ?? null)
      )}
    </td>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Delivery rate by month placed</h3>
        <p className="text-xs text-gray-400">
          <strong>Overall business</strong> is delivered ÷ <em>every order that came in</em> that month, so orders nobody
          ever shipped count against it — the same figure as the Delivery Rate row on the monthly Income Statement. Every
          row beneath it scores the courier instead: delivered ÷ <em>orders handed to Khazenly</em> — give Khazenly 50 of a
          month&apos;s 100 orders and it delivers 40, and that reads 80%, not 40%. Orders nobody shipped count nowhere below
          the top row. Bucketed by the month each order was placed, so the current month is still settling and its rate
          rises as orders land. Hover a cell for the counts. The amber{" "}
          <span className="text-amber-600">n open</span> under a rate counts parcels Khazenly hasn&apos;t marked delivered
          or not delivered yet. They stay in the denominator, so that month reads honestly low rather than falsely perfect,
          and its rate can still rise. A cell showing <strong>—</strong> has nothing confirmed either way yet, so it has no
          rate at all — 0% would claim we know they all failed.{" "}
          <strong>Click any rate</strong> to download that month&apos;s orders — number, date placed, and whether each was
          delivered, not delivered, still in progress, or never handed to a courier. The file also lists orders that never
          went out, so it holds more rows than a courier row&apos;s denominator.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="sticky left-0 z-10 bg-gray-200 px-3 py-2 text-left text-xs font-medium uppercase text-gray-400">
                Delivery rate
              </th>
              {months.map((m) => (
                <th key={m} className="px-3 py-2 text-right text-xs font-semibold text-gray-900">
                  {fmtMonthShort(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr className="border-b border-gray-200 bg-gray-100 font-semibold">
              <td className="sticky left-0 z-10 bg-gray-100 px-3 py-2 text-gray-900">
                Overall business
                <span className="ml-1 font-normal text-gray-400">÷ all orders</span>
              </td>
              {months.map((m) => businessCell(m, businessByMonth.get(m)))}
            </tr>

            <tr className="bg-gray-50 font-semibold">
              <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-900">
                All couriers
                <span className="ml-1 font-normal text-gray-400">÷ shipped</span>
              </td>
              {months.map((m) => rateCellWithOpen(m, overallByMonth.get(m), false, {}))}
            </tr>

            {byCourier.map((c) => (
              <tr key={c.courier} className="text-gray-700">
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700">{courierLabel(c.courier)}</td>
                {months.map((m) => rateCellWithOpen(m, c.byMonth[m], true, { courier: c.courier }))}
              </tr>
            ))}

            {productRates.map((p) => (
              <tr key={p.productId} className="text-gray-700">
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700">{p.name}</td>
                {months.map((m) => rateCell(m, p.byMonth[m], true, { productId: p.productId }))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color ?? "text-gray-900"}`}>{value}</div>
    </div>
  );
}
