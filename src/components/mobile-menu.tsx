"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** Phone-width navigation: a disclosure that closes itself after each navigation. */
export function MobileMenu({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  return (
    <details ref={ref} className="group relative lg:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-800 [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path className="group-open:hidden" d="M3 6h14M3 10h14M3 14h14" />
          <path className="hidden group-open:block" d="M5 5l10 10M15 5L5 15" />
        </svg>
        Menu
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
        {children}
      </div>
    </details>
  );
}
