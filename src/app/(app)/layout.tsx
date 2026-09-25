import { getViewer } from "@/lib/access";
import { visiblePages } from "@/lib/permissions";
import { NavLinks, type NavLink } from "./nav-links";
import { SyncButton } from "./sync-button";
import { MobileNav } from "./mobile-nav";

const BRAND_NAVY = "#050a30";

const COMING_SOON: string[] = [];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

  // Header tabs come from this user's permissions (see src/lib/permissions.ts).
  const links: NavLink[] = visiblePages(viewer).map((p) => ({ href: p.href, label: p.label }));

  return (
    <div className="flex min-h-full flex-1 flex-col bg-gray-50 text-gray-900">
      <header style={{ backgroundColor: BRAND_NAVY }}>
        <MobileNav links={links} canSync={viewer.canSync} signedIn={viewer.session !== null} />
        <nav className="mx-auto hidden max-w-6xl items-center gap-1 px-4 py-3 sm:flex">
          <span className="mr-4 font-semibold text-white">NUMA</span>
          <NavLinks links={links} />
          {viewer.isOwner &&
            COMING_SOON.map((label) => (
              <span
                key={label}
                className="rounded-md px-3 py-1.5 text-sm text-white/40 cursor-not-allowed"
                title="Coming soon"
              >
                {label}
              </span>
            ))}
          {viewer.canSync && <SyncButton className="ml-auto" />}
          {viewer.session && (
            <form action="/api/logout" method="POST" className={viewer.canSync ? "" : "ml-auto"}>
              <button type="submit" className="rounded-md px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
                Sign out
              </button>
            </form>
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
