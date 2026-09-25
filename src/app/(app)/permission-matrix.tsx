"use client";

import { allPermissions, PERMISSION_TREE, tabKey, type Access, type PageDef, type PermissionMap } from "@/lib/permissions";

// The checkbox tree an owner fills in when creating or editing a user: one row
// per header tab, indented rows for that tab's inner tabs, and a View/Edit pair
// on each. "Edit" is only offered where something on that tab can actually be
// changed - everywhere else it's a dash.
//
// The rows keep themselves coherent so the saved map can't say something silly:
// ticking a page ticks all of its tabs, unticking the last tab unticks the page,
// and ticking Edit ticks View. src/lib/permissions.ts re-checks all of this on
// the server, since anyone can POST whatever they like.
export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
}: {
  value: PermissionMap;
  onChange: (next: PermissionMap) => void;
  disabled?: boolean;
}) {
  const get = (key: string): Access => value[key] ?? { view: false, edit: false };

  function setPageView(page: PageDef, on: boolean) {
    const next = { ...value };
    if (on) {
      next[page.key] = { view: true, edit: get(page.key).edit };
      // A header tab with no inner tab ticked shows an empty shell, so grant
      // them all - the owner can then untick the ones they don't want.
      for (const tab of page.tabs) {
        const key = tabKey(page.key, tab.key);
        next[key] = { view: true, edit: get(key).edit };
      }
    } else {
      delete next[page.key];
      for (const tab of page.tabs) delete next[tabKey(page.key, tab.key)];
    }
    onChange(next);
  }

  function setPageEdit(page: PageDef, on: boolean) {
    const next = { ...value };
    if (on && !get(page.key).view) {
      next[page.key] = { view: true, edit: true };
      for (const tab of page.tabs) {
        const key = tabKey(page.key, tab.key);
        next[key] = { view: true, edit: get(key).edit };
      }
    } else {
      next[page.key] = { view: get(page.key).view, edit: on };
    }
    onChange(next);
  }

  function setTabView(page: PageDef, tab: string, on: boolean) {
    const key = tabKey(page.key, tab);
    const next = { ...value };
    if (on) {
      next[key] = { view: true, edit: get(key).edit };
      next[page.key] = { view: true, edit: get(page.key).edit };
    } else {
      delete next[key];
      const anyLeft = page.tabs.some((t) => next[tabKey(page.key, t.key)]?.view);
      if (!anyLeft) delete next[page.key];
    }
    onChange(next);
  }

  function setTabEdit(page: PageDef, tab: string, on: boolean) {
    const key = tabKey(page.key, tab);
    const next = { ...value };
    next[key] = { view: on || get(key).view, edit: on };
    if (on) next[page.key] = { view: true, edit: get(page.key).edit };
    onChange(next);
  }

  const cellClass = "w-14 text-center";

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <span className="grow text-xs font-medium uppercase text-gray-400">Tab access</span>
        <span className={`${cellClass} text-[10px] font-medium uppercase text-gray-400`}>View</span>
        <span className={`${cellClass} text-[10px] font-medium uppercase text-gray-400`}>Edit</span>
      </div>

      <div className="divide-y divide-gray-50">
        {PERMISSION_TREE.map((page) => {
          const pageAccess = get(page.key);
          return (
            <div key={page.key}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="grow text-sm font-medium text-gray-900">{page.label}</span>
                <span className={cellClass}>
                  <input
                    type="checkbox"
                    checked={pageAccess.view}
                    disabled={disabled}
                    onChange={(e) => setPageView(page, e.target.checked)}
                    aria-label={`${page.label} — view`}
                  />
                </span>
                <span className={cellClass}>
                  {page.edit ? (
                    <input
                      type="checkbox"
                      checked={pageAccess.edit}
                      disabled={disabled}
                      title={page.edit}
                      onChange={(e) => setPageEdit(page, e.target.checked)}
                      aria-label={`${page.label} — edit`}
                    />
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </span>
              </div>

              {page.tabs.map((tab) => {
                const access = get(tabKey(page.key, tab.key));
                return (
                  <div key={tab.key} className="flex items-center gap-2 py-1.5 pl-8 pr-3">
                    <span className="grow text-xs text-gray-600">{tab.label}</span>
                    <span className={cellClass}>
                      <input
                        type="checkbox"
                        checked={access.view}
                        disabled={disabled}
                        onChange={(e) => setTabView(page, tab.key, e.target.checked)}
                        aria-label={`${page.label} / ${tab.label} — view`}
                      />
                    </span>
                    <span className={cellClass}>
                      {tab.edit ? (
                        <input
                          type="checkbox"
                          checked={access.edit}
                          disabled={disabled}
                          title={tab.edit}
                          onChange={(e) => setTabEdit(page, tab.key, e.target.checked)}
                          aria-label={`${page.label} / ${tab.label} — edit`}
                        />
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-gray-100 px-3 py-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(allPermissions())}
          className="text-xs font-medium text-gray-600 hover:underline disabled:opacity-50"
        >
          Select all
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({})}
          className="text-xs font-medium text-gray-600 hover:underline disabled:opacity-50"
        >
          Clear
        </button>
        <span className="text-[11px] text-gray-400">
          Settings → Users lets them manage staff accounts; only an owner can create or change an owner.
        </span>
      </div>
    </div>
  );
}
