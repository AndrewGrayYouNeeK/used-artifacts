import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth/dal";

export function SiteHeader() {
  return (
    <header className="border-b border-stone-200 bg-white/70 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" className="font-serif text-xl font-semibold tracking-tight">
          Used Artifacts
        </Link>
        <Suspense fallback={<span className="h-5 w-24 animate-pulse rounded bg-stone-200" />}>
          <UserMenu />
        </Suspense>
      </div>
    </header>
  );
}

async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <nav className="flex items-center gap-4 text-sm">
        <Link href="/login" className="text-stone-700 hover:text-stone-950">
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-full bg-stone-900 px-4 py-1.5 text-white hover:bg-stone-700"
        >
          Join the beta
        </Link>
      </nav>
    );
  }
  return (
    <nav className="flex items-center gap-4 text-sm">
      {user.role === "OWNER" && (
        <Link href="/admin" className="text-stone-700 hover:text-stone-950">
          GM dashboard
        </Link>
      )}
      <Link href="/account" className="text-stone-700 hover:text-stone-950">
        {user.displayName}
      </Link>
      <form action={logoutAction}>
        <button type="submit" className="text-stone-500 hover:text-stone-950">
          Sign out
        </button>
      </form>
    </nav>
  );
}
