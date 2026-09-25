// Shown when a page's requirePageView() finds nothing this user may open, so
// there's nowhere to redirect them either (every tab is switched off).
export function NoAccess() {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
      <p className="font-medium text-gray-900">No tabs are shared with your account yet.</p>
      <p className="mt-1 text-xs">Ask the owner to give you access from Settings → Users.</p>
    </div>
  );
}
