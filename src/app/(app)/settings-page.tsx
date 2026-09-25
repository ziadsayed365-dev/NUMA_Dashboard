"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppUser } from "@/lib/settings/users";
import { describePermissions, type PermissionMap } from "@/lib/permissions";
import { PermissionMatrix } from "./permission-matrix";
import { PERF_EXPENSE_ACCOUNTS, type PerfExpenseHistory } from "@/lib/settings/perf-expenses";
import type { AdAllocation } from "@/lib/reports/ad-allocation";
import type { ProductOption } from "@/lib/reports/per-product";
import type { FixedAsset } from "@/lib/settings/fixed-assets";
import { AllocationPicker, allocationBody, allocationIsEmpty, describeAllocation, type Allocation } from "./allocation-picker";

const SETTINGS_TABS = [
  ["expenses", "Fixed Expenses"],
  ["ads", "Ad Allocation"],
  ["assets", "Fixed Assets"],
  ["users", "Users"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];

export function SettingsPage({
  users,
  perfHistory,
  adAllocations,
  productOptions,
  fixedAssets,
  isOwner,
  access,
}: {
  users: AppUser[];
  perfHistory: PerfExpenseHistory;
  adAllocations: AdAllocation[];
  productOptions: ProductOption[];
  fixedAssets: FixedAsset[];
  /** Owners are the only ones who may create or change another owner. */
  isOwner: boolean;
  /** view/edit per Settings tab, from src/lib/permissions.ts. */
  access: Record<SettingsTab, { view: boolean; edit: boolean }>;
}) {
  const router = useRouter();
  // Settings is grantable a tab at a time, so someone can hold (say) only Ad
  // Allocation and never see the rest.
  const settingsTabs = SETTINGS_TABS.filter(([key]) => access[key].view);
  const [tab, setTab] = useState<SettingsTab>(settingsTabs[0]?.[0] ?? "expenses");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"owner" | "staff">("staff");
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<"owner" | "staff">("staff");
  const [editPermissions, setEditPermissions] = useState<PermissionMap>({});
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const inputClass = "mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm";
  const editInputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setUserError(null);
    if (!username.trim() || !password) {
      setUserError("Username and password are required.");
      return;
    }

    setUserSubmitting(true);
    try {
      const res = await fetch("/api/settings/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role, permissions }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to add user");
      setUsername("");
      setPassword("");
      setRole("staff");
      router.refresh();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : "Failed to add user");
    } finally {
      setUserSubmitting(false);
    }
  }

  function startEdit(u: AppUser) {
    setEditingId(u.id);
    setEditUsername(u.username);
    setEditPassword("");
    setEditRole(u.role);
    setEditPermissions(u.permissions);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    if (!editUsername.trim()) {
      setEditError("Username is required.");
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/settings/users/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: editUsername,
          password: editPassword || undefined,
          role: editRole,
          permissions: editPermissions,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this user?")) return;

    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/settings/users/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to delete user");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-gray-200">
        {settingsTabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "expenses" && (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Fixed Expenses (Performance P&amp;L)</h2>
          <p className="text-xs text-gray-400">
            Monthly amounts subtracted on the Performance Income Statement. Each amount takes effect from the month you choose
            and applies to that month onward — earlier months keep the amount that was in effect then, so updating a figure
            never rewrites your history.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {PERF_EXPENSE_ACCOUNTS.map((acc) => (
            <ExpenseAccountEditor key={acc.slug} slug={acc.slug} label={acc.label} entries={perfHistory[acc.key]} />
          ))}
        </div>
      </section>
      )}

      {tab === "ads" && <AdAllocationsSection allocations={adAllocations} products={productOptions} />}

      {tab === "assets" && <FixedAssetsTab assets={fixedAssets} />}

      {tab === "users" && (
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Users</h2>

        {access.users.edit && (
        <form onSubmit={handleAddUser} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500">Username</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">Role</label>
              {/* "Operations" is gone - it was a fixed page list, and the matrix
                  below expresses the same thing (and anything else) per user. */}
              <select value={role} onChange={(e) => setRole(e.target.value as "owner" | "staff")} className={inputClass}>
                <option value="staff">Staff</option>
                {isOwner && <option value="owner">Owner</option>}
              </select>
            </div>
            <button
              type="submit"
              disabled={userSubmitting}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {userSubmitting ? "Adding…" : "Add user"}
            </button>
            {userError && <span className="text-xs text-red-600">{userError}</span>}
          </div>

          {/* Owners are unrestricted, so the matrix only applies to staff. */}
          {role === "staff" && <PermissionMatrix value={permissions} onChange={setPermissions} disabled={userSubmitting} />}
        </form>
        )}

        {deleteError && <div className="text-xs text-red-600">{deleteError}</div>}

        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-400">
              <tr>
                <th className="w-[24%] px-3 py-2">Username</th>
                <th className="w-[14%] px-3 py-2">Role</th>
                <th className="w-[38%] px-3 py-2">Tabs</th>
                <th className="w-[24%] px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => {
                if (editingId === u.id) {
                  return (
                    <tr key={u.id} className="bg-blue-50/40">
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={editUsername}
                          onChange={(e) => setEditUsername(e.target.value)}
                          className={editInputClass}
                        />
                        <input
                          type="text"
                          disabled
                          value="••••••••"
                          title="The actual password can't be shown - it's stored hashed, not in plain text"
                          className={`${editInputClass} mt-1 cursor-not-allowed bg-gray-100 text-gray-400`}
                        />
                        <input
                          type="password"
                          placeholder="New password (optional)"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          className={`${editInputClass} mt-1`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value as "owner" | "staff")}
                          className={editInputClass}
                        >
                          <option value="staff">Staff</option>
                          {isOwner && <option value="owner">Owner</option>}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {editRole === "staff" ? (
                          <PermissionMatrix value={editPermissions} onChange={setEditPermissions} disabled={editSubmitting} />
                        ) : (
                          <span className="text-xs text-gray-400">Owners have full access.</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1">
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={saveEdit}
                              disabled={editSubmitting}
                              className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                            >
                              {editSubmitting ? "…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                            >
                              Cancel
                            </button>
                          </div>
                          {editError && <span className="text-[11px] text-red-600">{editError}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={u.id} className="text-gray-700">
                    <td className="px-3 py-2">{u.username}</td>
                    <td className="px-3 py-2 capitalize">{u.role}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {u.role === "owner" ? "All tabs (owner)" : describePermissions(u.permissions)}
                    </td>
                    <td className="px-3 py-2">
                      {/* A non-owner with this tab manages staff, but an owner's
                          account is off limits - the API enforces the same rule. */}
                      {access.users.edit && (isOwner || u.role !== "owner") ? (
                        <div className="flex gap-2">
                          <button type="button" onClick={() => startEdit(u)} className="text-xs font-medium text-gray-600 hover:underline">
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(u.id)}
                            disabled={deletingId === u.id}
                            className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                          >
                            {deletingId === u.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-gray-400">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}
    </div>
  );
}

// Render a "YYYY-MM-01" effective month as e.g. "Jan 2026".
function fmtMonthLabel(month: string): string {
  return new Date(month + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// The timeline editor for a single fixed-expense account: its list of
// effective amounts (each editable / removable) plus a row to add a new amount
// effective from a chosen month. Every change hits /api/settings/fixed-expenses
// and refreshes so the Performance P&L reflects it immediately.
function ExpenseAccountEditor({
  slug,
  label,
  entries,
}: {
  slug: string;
  label: string;
  entries: { month: string; amount: number }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addMonth, setAddMonth] = useState("");
  const [addAmount, setAddAmount] = useState("");

  async function call(method: "POST" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/fixed-expenses", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!addMonth) {
      setError("Pick a month.");
      return;
    }
    const amount = addAmount.trim() === "" ? 0 : Number(addAmount);
    // The API normalises any day in the month to its first; send the 1st.
    const ok = await call("POST", { account: slug, effectiveMonth: `${addMonth}-01`, amount });
    if (ok) {
      setAddMonth("");
      setAddAmount("");
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-medium text-gray-900">{label}</h3>
      <p className="mt-0.5 text-[11px] text-gray-400">EGP per month, by effective date.</p>

      <div className="mt-3 space-y-1.5">
        {entries.length === 0 && <div className="text-xs text-gray-400">No amounts set yet.</div>}
        {entries.map((entry) => (
          <EntryRow key={entry.month} slug={slug} entry={entry} busy={busy} onSave={call} onDelete={call} />
        ))}
      </div>

      <form onSubmit={addEntry} className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Effective from</label>
          <input
            type="month"
            value={addMonth}
            onChange={(e) => setAddMonth(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Amount (EGP/mo)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={addAmount}
            onChange={(e) => setAddAmount(e.target.value)}
            className="mt-1 w-28 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

// One effective amount within an account: edit the amount in place (month is
// the row's identity — to move it, delete and re-add) or remove it entirely.
function EntryRow({
  slug,
  entry,
  busy,
  onSave,
  onDelete,
}: {
  slug: string;
  entry: { month: string; amount: number };
  busy: boolean;
  onSave: (method: "POST", body: Record<string, unknown>) => Promise<boolean>;
  onDelete: (method: "DELETE", body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [amount, setAmount] = useState(String(entry.amount));
  const dirty = amount.trim() !== "" && Number(amount) !== entry.amount;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-gray-50 px-2 py-1.5">
      <span className="w-20 text-xs font-medium text-gray-600">{fmtMonthLabel(entry.month)}</span>
      <input
        type="number"
        min="0"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={busy}
        className="w-28 rounded border border-gray-300 px-2 py-1 text-xs text-right"
      />
      {dirty ? (
        <button
          type="button"
          onClick={() => onSave("POST", { account: slug, effectiveMonth: entry.month, amount: Number(amount) })}
          disabled={busy}
          className="rounded bg-gray-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Save
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onDelete("DELETE", { account: slug, effectiveMonth: entry.month })}
          disabled={busy}
          className="px-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
          title="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
}

// Management view of every ad the owner has already allocated. Each row's products
// are editable inline (click, tick, Save); saving re-runs the same allocation the popup does, so
// it applies to all of that ad's spend (past days now, future days via the Meta
// sync). Filter by text (ad/campaign/product) and by product to find a row fast.
function AdAllocationsSection({ allocations, products }: { allocations: AdAllocation[]; products: ProductOption[] }) {
  const [list, setList] = useState(allocations);
  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState("all"); // "all" | "general" | String(productId)
  // Empty = no bound on that side, so the default is the lifetime total the
  // section has always shown. Re-totalled from each ad's daily series, which
  // ships with the page - no refetch, so the range responds as you type.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const ranged = from !== "" || to !== "";
  const q = query.trim().toLowerCase();
  const rows = list
    .map((a) => {
      if (!ranged) return { alloc: a, spend: a.spend };
      let spend = 0;
      for (const d of a.daily) {
        if (from && d.date < from) continue;
        if (to && d.date > to) continue;
        spend += d.spend;
      }
      return { alloc: a, spend };
    })
    // Biggest spender first, on whichever total is being shown - the point of
    // the range filter is to find where the money went in that window.
    .sort((x, y) => y.spend - x.spend);

  const filtered = rows.filter(({ alloc: a }) => {
    if (productFilter === "general" && a.productIds.length > 0) return false;
    if (productFilter !== "all" && productFilter !== "general" && !a.productIds.includes(Number(productFilter))) return false;
    if (q) {
      const hay = [a.adName, a.campaignName, a.adsetName, ...a.productNames, a.adId].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const filteredTotal = filtered.reduce((sum, r) => sum + r.spend, 0);

  function onChanged(adId: string, productIds: number[], productNames: string[]) {
    setList((l) => l.map((a) => (a.adId === adId ? { ...a, productIds, productNames } : a)));
  }
  function onRemoved(adId: string) {
    setList((l) => l.filter((a) => a.adId !== adId));
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Ad Allocations</h2>
        <p className="text-xs text-gray-400">
          Which product each ad&apos;s spend is attributed to. Click a row to change it: tick one product, several to split the
          spend equally between them, or General to split it equally across all products; the Subscription only takes a share on days a
          subscription sold (Unallocate sends it back to the allocation popup) — the change applies to all of that ad&apos;s spend, past and future. Spend shows lifetime by default; set a date range to see what each ad cost in that window instead.
        </p>
      </div>

      {/* Header filter: free-text search + a product filter. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grow">
          <label className="block text-[11px] font-medium text-gray-500">Search</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ad, campaign or product…"
            className="mt-1 w-full max-w-xs rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Product</label>
          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="all">All products</option>
            <option value="general">General (all products)</option>
            {products.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Spend from</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        {ranged && (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="mb-[1px] rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            All time
          </button>
        )}
        <span className="pb-1 text-[11px] text-gray-400">
          {filtered.length} of {list.length} · {filteredTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} spent
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-left text-[10px] font-medium uppercase text-gray-400">
            <tr className="border-b border-gray-100">
              <th className="w-[38%] py-2 pl-4">Ad</th>
              <th className="w-[10%] py-2">Source</th>
              <th className="w-[14%] py-2 text-right">{ranged ? "Spend in range" : "Spend"}</th>
              <th className="w-[38%] py-2 pl-4">Product</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map(({ alloc, spend }) => (
              <AllocationRow
                key={alloc.adId}
                alloc={alloc}
                spend={spend}
                products={products}
                onChanged={onChanged}
                onRemoved={onRemoved}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 pl-4 text-gray-400">
                  {list.length === 0 ? "No allocations yet." : "No allocations match the filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AllocationRow({
  alloc,
  spend,
  products,
  onChanged,
  onRemoved,
}: {
  alloc: AdAllocation;
  spend: number; // lifetime, or just the selected date range - the section decides
  products: ProductOption[];
  onChanged: (adId: string, productIds: number[], productNames: string[]) => void;
  onRemoved: (adId: string) => void;
}) {
  const saved: Allocation = { productIds: alloc.productIds, isGeneral: alloc.productIds.length === 0 };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Allocation>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Allocation) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(allocationBody(alloc.adId, next)),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      const ids = next.isGeneral ? [] : next.productIds;
      onChanged(alloc.adId, ids, ids.map((id) => products.find((p) => p.id === id)?.label ?? `#${id}`));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adId: alloc.adId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      onRemoved(alloc.adId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  }

  const context = [alloc.campaignName, alloc.adsetName].filter(Boolean).join(" › ");

  return (
    <tr className="text-gray-700">
      <td className="py-2 pl-4">
        <div className="truncate font-medium text-gray-900">{alloc.adName ?? "(unnamed ad)"}</div>
        {context && <div className="truncate text-[11px] text-gray-500">{context}</div>}
        <div className="truncate text-[11px] text-gray-400">Ad ID: {alloc.adId}</div>
      </td>
      <td className="py-2 text-gray-500">{alloc.source ?? "—"}</td>
      <td className="py-2 text-right">{spend.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
      <td className="py-2 pl-4">
        {editing ? (
          <div className="max-w-[260px] space-y-1">
            <AllocationPicker products={products} value={draft} onChange={setDraft} disabled={busy} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || allocationIsEmpty(draft)}
                onClick={() => save(draft)}
                className="rounded bg-gray-900 px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
              >
                Save
              </button>
              <button type="button" disabled={busy} onClick={remove} className="text-[11px] text-red-600">
                Unallocate
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(saved);
                  setEditing(false);
                }}
                className="text-[11px] text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            dir="auto"
            onClick={() => {
              setDraft(saved);
              setEditing(true);
            }}
            className="rounded border border-transparent px-1 py-0.5 text-left hover:border-gray-300 hover:bg-gray-50"
          >
            {describeAllocation(saved, products)}
            {alloc.productIds.length > 1 && <span className="ml-1 text-[10px] text-gray-400">(split equally)</span>}
          </button>
        )}
        {busy && <span className="ml-2 text-[11px] text-gray-400">Saving…</span>}
        {error && <span className="ml-2 text-[11px] text-red-600">{error}</span>}
      </td>
    </tr>
  );
}

// ---- Fixed Assets: record an asset (name, purchase date, amount, useful life
// in years) and see its straight-line monthly depreciation. Kept here as an
// asset register only - the Income Statement no longer carries a Depreciation
// line.
function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function FixedAssetsTab({ assets }: { assets: FixedAsset[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [amount, setAmount] = useState("");
  const [years, setYears] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter a name.");
    if (!purchaseDate) return setError("Pick a purchase date.");
    if (!(Number(amount) >= 0)) return setError("Enter a valid amount.");
    if (!(Number(years) > 0)) return setError("Enter a useful life (years).");
    setBusy(true);
    try {
      const res = await fetch("/api/settings/fixed-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), purchaseDate, amount: Number(amount), usefulLifeYears: Number(years) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      setName("");
      setPurchaseDate("");
      setAmount("");
      setYears("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Fixed Assets</h2>
        <p className="text-xs text-gray-400">
          Record an asset with its purchase date, amount and useful life (years). Each depreciates straight-line
          (amount ÷ years ÷ 12 per month) from its purchase month until fully written off. This is an asset
          register only — the Income Statement no longer carries a Depreciation line.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div className="grow">
          <label className="block text-xs font-medium text-gray-500">Asset</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Laptops"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Purchase date</label>
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Amount</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-28 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Useful life (years)</label>
          <input type="number" min="0" step="0.5" value={years} onChange={(e) => setYears(e.target.value)} className="mt-1 w-28 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
        <button type="submit" disabled={busy} className="rounded bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {busy ? "Saving…" : "Add asset"}
        </button>
        {error && <p className="basis-full text-xs text-red-600">{error}</p>}
      </form>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2">Purchased</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Life (yrs)</th>
              <th className="px-3 py-2 text-right">Depreciation / mo</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {assets.map((a) => (
              <AssetRow key={a.id} asset={a} />
            ))}
            {assets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                  No assets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AssetRow({ asset }: { asset: FixedAsset }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const monthly = asset.usefulLifeYears > 0 ? asset.amount / (asset.usefulLifeYears * 12) : 0;

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/fixed-assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: asset.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={`text-gray-700 ${busy ? "opacity-50" : ""}`}>
      <td className="px-3 py-2 text-gray-900">{asset.name}</td>
      <td className="px-3 py-2">{asset.purchaseDate}</td>
      <td className="px-3 py-2 text-right">{fmtNum(asset.amount)}</td>
      <td className="px-3 py-2 text-right">{fmtNum(asset.usefulLifeYears)}</td>
      <td className="px-3 py-2 text-right text-gray-600">{fmtNum(monthly)}</td>
      <td className="px-3 py-2 text-right">
        <button type="button" onClick={remove} disabled={busy} className="px-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50" title="Remove">
          ×
        </button>
      </td>
    </tr>
  );
}
