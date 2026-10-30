import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "@/app/actions/auth";
import { MobileMenu } from "@/components/mobile-menu";
import { getCurrentUser } from "@/lib/auth/dal";

export function SiteHeader() {
  return (
    <header className="relative z-40 border-b border-stone-200 bg-white/70 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6 sm:py-4">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 font-serif text-lg font-semibold tracking-tight sm:text-xl">
          <Image src="/logo.webp" alt="" width={40} height={40} priority className="h-9 w-9 sm:h-10 sm:w-10" />
          Used Artifacts
        </Link>
        <Suspense fallback={<span className="h-5 w-24 animate-pulse rounded bg-stone-200" />}>
          <UserMenu />
        </Suspense>
      </div>
    </header>
  );
}

const desktopLink = "whitespace-nowrap text-stone-700 hover:text-stone-950";
const mobileLink = "block rounded-lg px-3 py-2 text-stone-800 hover:bg-stone-100";

async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <nav className="flex items-center gap-3 text-sm sm:gap-4">
        <Link href="/browse" className={`hidden sm:inline ${desktopLink}`}>
          Browse
        </Link>
        <Link href="/login" className={desktopLink}>
          Sign in
        </Link>
        <Link
          href="/signup"
          className="whitespace-nowrap rounded-full bg-stone-900 px-4 py-1.5 text-white hover:bg-stone-700"
        >
          Join the beta
        </Link>
      </nav>
    );
  }

  const isStaff = user.role === "OWNER" || user.role === "MODERATOR";
  const links = [
    { href: "/browse", label: "Browse" },
    { href: "/orders", label: "Purchases" },
    { href: "/sell", label: "Sell" },
    ...(isStaff
      ? [
          { href: "/admin/compliance", label: "Compliance" },
          { href: "/admin/orders", label: "Orders" },
        ]
      : []),
    ...(user.role === "OWNER" ? [{ href: "/admin", label: "GM dashboard" }] : []),
    { href: "/feedback", label: "Feedback" },
    { href: "/account", label: user.displayName },
  ];

  return (
    <>
      <nav className="hidden items-center gap-4 text-sm lg:flex">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={desktopLink}>
            {l.label}
          </Link>
        ))}
        <form action={logoutAction}>
          <button type="submit" className="whitespace-nowrap text-stone-500 hover:text-stone-950">
            Sign out
          </button>
        </form>
      </nav>
      <MobileMenu>
        <nav className="text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={mobileLink}>
              {l.label}
            </Link>
          ))}
          <form action={logoutAction} className="mt-1 border-t border-stone-100 pt-1">
            <button type="submit" className={`w-full text-left text-stone-500 ${mobileLink}`}>
              Sign out
            </button>
          </form>
        </nav>
      </MobileMenu>
    </>
  );
}
