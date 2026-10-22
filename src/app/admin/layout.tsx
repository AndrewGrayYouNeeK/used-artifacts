import { Suspense } from "react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/dal";

const NAV = [
  { href: "/admin", label: "Overview", ownerOnly: true },
  { href: "/admin/users", label: "Users", ownerOnly: false },
  { href: "/admin/listings", label: "Listings", ownerOnly: false },
  { href: "/admin/orders", label: "Orders", ownerOnly: false },
  { href: "/admin/compliance", label: "Compliance", ownerOnly: false },
  { href: "/admin/trust", label: "Trust & safety", ownerOnly: false },
  { href: "/admin/feedback", label: "Feedback", ownerOnly: false },
  { href: "/admin/beta", label: "Beta controls", ownerOnly: false },
  { href: "/admin/audit", label: "Audit log", ownerOnly: true },
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-6 py-2 text-sm">
          <Suspense fallback={<NavLinks isOwner={false} />}>
            <RoleNav />
          </Suspense>
        </div>
      </nav>
      {children}
    </div>
  );
}

async function RoleNav() {
  const user = await getCurrentUser();
  return <NavLinks isOwner={user?.role === "OWNER"} />;
}

function NavLinks({ isOwner }: { isOwner: boolean }) {
  return NAV.filter((item) => isOwner || !item.ownerOnly).map((item) => (
    <Link key={item.href} href={item.href} className="whitespace-nowrap rounded-md px-3 py-1.5 text-stone-600 hover:bg-stone-100 hover:text-stone-900">
      {item.label}
    </Link>
  ));
}
