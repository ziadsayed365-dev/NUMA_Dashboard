// Instant navigation fallback: App Router streams this in the moment a tab is
// clicked, so switching pages shows a skeleton immediately instead of the
// previous page appearing frozen while the server aggregates the P&L data.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-6 w-48 rounded bg-gray-200" />
      <div className="flex gap-2">
        <div className="h-8 w-28 rounded bg-gray-200" />
        <div className="h-8 w-28 rounded bg-gray-200" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-gray-200" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-9 rounded bg-gray-200" />
        ))}
      </div>
    </div>
  );
}
