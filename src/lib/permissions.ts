// The one place that describes what a user can be given access to.
//
// Access is per header tab (a page) and per inner tab within it, and each of
// those carries two rights: view (can open it) and edit (can change data from
// it). Owner accounts bypass all of this - they always have everything.
//
// This replaced the old three-role split (owner / staff / operations). The
// `operations` role is gone: what it granted - Expense & Income plus Purchasing
// - is just a set of ticks in this tree, and migration 0069 backfills exactly
// that for anyone who held it, so nobody's access changed on the way over.
//
// Settings is grantable a tab at a time like anything else, so a non-owner can
// be given (say) only Ad Allocation. The one thing the matrix can't hand out is
// ownership: creating an owner, or editing/deleting an owner account, needs an
// owner - see the guards in src/app/api/settings/users.
//
// Client-safe on purpose: the Settings checkbox matrix imports it, so it must
// stay free of `server-only`, supabase, and next/headers. The server-side
// helpers that read a real user's permissions live in src/lib/access.ts.

export type Access = { view: boolean; edit: boolean };

// Keys are "<page>" for a header tab and "<page>:<tab>" for an inner tab.
export type PermissionMap = Record<string, Access>;

/** `edit` doubles as the checkbox's tooltip - omit it for read-only tabs. */
export type TabDef = { key: string; label: string; edit?: string };
export type PageDef = { key: string; label: string; href: string; edit?: string; tabs: readonly TabDef[] };

export const PERMISSION_TREE: readonly PageDef[] = [
  {
    key: "income-statement",
    label: "Income Statement",
    href: "/",
    tabs: [
      { key: "performance", label: "Performance" },
      { key: "actual", label: "Actual" },
    ],
  },
  {
    key: "products",
    label: "Analysis by Product",
    href: "/products",
    tabs: [
      { key: "all", label: "All Products" },
      { key: "rollforward", label: "Rollforward" },
    ],
  },
  {
    key: "record-data",
    label: "Expense & Income",
    href: "/record-data",
    tabs: [
      { key: "expenses", label: "Expense & Income", edit: "Add and change the recorded expense / income figures" },
      { key: "report", label: "Report" },
    ],
  },
  {
    key: "shipping-orders",
    label: "Shipping Orders",
    href: "/shipping-orders",
    // Shipments themselves aren't recorded here - they arrive from Shopify with
    // Khazenly's delivery status - so returns are the only courier upload.
    tabs: [
      { key: "returns", label: "Record Returns", edit: "Upload the returns list" },
      { key: "analysis", label: "Analysis" },
    ],
  },
  // Read-only: renewals are Shopify orders, so there is nothing to type here.
  {
    key: "subscription",
    label: "Subscription",
    href: "/subscription",
    tabs: [],
  },
  {
    key: "purchasing",
    label: "Purchasing",
    href: "/purchasing",
    tabs: [
      { key: "recording", label: "Recording", edit: "Add and change purchase records" },
      { key: "report", label: "Report" },
      // View shows the ledger and nothing else. Edit is what lets someone type
      // the daily Adjustments figures - the one hand-entered line in the ledger -
      // and reach the groups and opening balances.
      {
        key: "inventory",
        label: "Inventory",
        edit: "Type the daily stock adjustments, edit groups, and set opening balances",
      },
    ],
  },
  {
    key: "product-list",
    label: "Product List",
    href: "/product-list",
    tabs: [
      { key: "components", label: "Product Components", edit: "Add and change component costs" },
      { key: "final", label: "Final Product", edit: "Change the final product bill of materials" },
      { key: "products", label: "Product List", edit: "Assign a model and cost to each product" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    href: "/settings",
    tabs: [
      { key: "expenses", label: "Fixed Expenses", edit: "Change the fixed expense figures" },
      { key: "ads", label: "Ad Allocation", edit: "Change which model an ad's spend belongs to" },
      { key: "assets", label: "Fixed Assets", edit: "Add and change fixed assets" },
      { key: "users", label: "Users", edit: "Add, change and delete users" },
    ],
  },
] as const;

export type Viewer = { isOwner: boolean; permissions: PermissionMap };

export const NO_ACCESS: Viewer = { isOwner: false, permissions: {} };

export function tabKey(pageKey: string, tab: string): string {
  return `${pageKey}:${tab}`;
}

/** "purchasing:report" -> "purchasing"; a page key maps to itself. */
export function pageKeyOf(key: string): string {
  return key.split(":")[0];
}

export function findPage(pageKey: string): PageDef | undefined {
  return PERMISSION_TREE.find((p) => p.key === pageKey);
}

export function findPageByHref(href: string): PageDef | undefined {
  return PERMISSION_TREE.find((p) => p.href === href);
}

/** Whether a tab's `edit` right means anything (nothing on that tab is editable otherwise). */
export function isEditable(key: string): boolean {
  const page = findPage(pageKeyOf(key));
  if (!page) return false;
  if (key === page.key) return page.edit !== undefined;
  return page.tabs.find((t) => tabKey(page.key, t.key) === key)?.edit !== undefined;
}

/** Is this a page or inner tab the tree actually defines? */
export function isKnownKey(key: string): boolean {
  const page = findPage(pageKeyOf(key));
  if (!page) return false;
  return key === page.key || page.tabs.some((t) => tabKey(page.key, t.key) === key);
}

// An inner tab is only reachable if its page is too, so both checks apply. Keys
// outside the tree (a renamed tab, or "settings" smuggled into a hand-written
// map) are never viewable, so a permission map that skipped normalization still
// can't grant anything the tree doesn't define.
export function canView(viewer: Viewer, key: string): boolean {
  if (viewer.isOwner) return true;
  if (!isKnownKey(key)) return false;
  const page = pageKeyOf(key);
  if (!viewer.permissions[page]?.view) return false;
  return key === page || viewer.permissions[key]?.view === true;
}

export function canEdit(viewer: Viewer, key: string): boolean {
  if (viewer.isOwner) return true;
  return canView(viewer, key) && viewer.permissions[key]?.edit === true;
}

/** Header tabs this viewer may open, in tree order. */
export function visiblePages(viewer: Viewer): PageDef[] {
  return PERMISSION_TREE.filter((p) => canView(viewer, p.key));
}

/** Where to send someone who lands on a page they can't see. Null = nothing at all. */
export function firstAllowedPath(viewer: Viewer): string | null {
  if (viewer.isOwner) return "/";
  return visiblePages(viewer)[0]?.href ?? null;
}

function readAccess(raw: unknown): Access {
  if (!raw || typeof raw !== "object") return { view: false, edit: false };
  const o = raw as Record<string, unknown>;
  return { view: o.view === true, edit: o.edit === true };
}

// Rebuilds the map from the tree so stored data can never grant something the
// tree doesn't define (an old key left over from a renamed tab, an `edit` on a
// read-only tab, a tab whose page was switched off). The stored map is treated
// as a wish list; this decides what it actually means.
export function normalizePermissions(raw: unknown): PermissionMap {
  const stored: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: PermissionMap = {};

  for (const page of PERMISSION_TREE) {
    const pageAccess = readAccess(stored[page.key]);
    if (!pageAccess.view) continue;

    const tabs: [string, Access][] = [];
    for (const tab of page.tabs) {
      const key = tabKey(page.key, tab.key);
      const access = readAccess(stored[key]);
      if (!access.view) continue;
      tabs.push([key, { view: true, edit: access.edit && tab.edit !== undefined }]);
    }

    // A page whose every inner tab is off has nothing to show, so the page
    // itself is off too - otherwise the user lands on an empty shell.
    if (page.tabs.length > 0 && tabs.length === 0) continue;

    out[page.key] = { view: true, edit: pageAccess.edit && page.edit !== undefined };
    for (const [key, access] of tabs) out[key] = access;
  }

  return out;
}

export function emptyPermissions(): PermissionMap {
  return {};
}

/** Every box ticked - the starting point for "give them everything but Settings". */
export function allPermissions(): PermissionMap {
  const out: PermissionMap = {};
  for (const page of PERMISSION_TREE) {
    out[page.key] = { view: true, edit: page.edit !== undefined };
    for (const tab of page.tabs) {
      out[tabKey(page.key, tab.key)] = { view: true, edit: tab.edit !== undefined };
    }
  }
  return out;
}

/** "3 of 8 tabs" style summary for the users table. */
export function describePermissions(permissions: PermissionMap): string {
  const viewer: Viewer = { isOwner: false, permissions };
  const pages = visiblePages(viewer);
  if (pages.length === 0) return "No access";
  if (pages.length === PERMISSION_TREE.length) return "All tabs";
  return pages.map((p) => p.label).join(", ");
}
