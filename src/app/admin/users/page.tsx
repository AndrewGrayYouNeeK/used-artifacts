import { Suspense } from "react";
import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { inputClass } from "@/components/action-form";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Users</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <UsersTable searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const STATUSES = ["ACTIVE", "SUSPENDED", "BANNED"] as const;
const ROLES = ["USER", "MODERATOR", "OWNER"] as const;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function UsersTable({ searchParams }: { searchParams: PageProps<"/admin/users">["searchParams"] }) {
  await requireStaff();
  const params = await searchParams;
  const q = one(params.q).trim();
  const status = STATUSES.find((s) => s === one(params.status));
  const role = ROLES.find((r) => r === one(params.role));
  const where: Prisma.UserWhereInput = {
    ...(q
      ? {
          OR: [
            { email: { contains: q.toLowerCase() } },
            { displayName: { contains: q, mode: "insensitive" } },
            { id: q },
            { ownedStorefronts: { some: { OR: [{ slug: { contains: q.toLowerCase() } }, { name: { contains: q, mode: "insensitive" } }] } } },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
    ...(role ? { role } : {}),
  };
  const users = await db.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
      createdAt: true,
      identityVerification: { select: { status: true } },
      ownedStorefronts: { select: { slug: true } },
    },
  });

  return (
    <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input name="q" defaultValue={q} placeholder="Email, name, storefront or user ID" className={inputClass} />
        <select name="status" defaultValue={status ?? ""} className={inputClass}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
        <select name="role" defaultValue={role ?? ""} className={inputClass}>
          <option value="">Any role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r.toLowerCase()}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
          Search
        </button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Email</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">ID check</th>
              <th className="py-2 pr-4">Storefront</th>
              <th className="py-2">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="py-2 pr-4">
                  <Link href={`/admin/users/${u.id}`} className="font-medium underline-offset-2 hover:underline">
                    {u.displayName}
                  </Link>
                </td>
                <td className="py-2 pr-4">
                  {u.email}
                  {!u.emailVerifiedAt && <span className="ml-1 text-xs text-stone-400">(unverified)</span>}
                </td>
                <td className="py-2 pr-4">{u.role.toLowerCase()}</td>
                <td className={`py-2 pr-4 ${u.status === "ACTIVE" ? "" : "font-medium text-red-700"}`}>{u.status.toLowerCase()}</td>
                <td className="py-2 pr-4">{u.identityVerification?.status.toLowerCase().replaceAll("_", " ") ?? "-"}</td>
                <td className="py-2 pr-4">{u.ownedStorefronts.map((s) => s.slug).join(", ") || "-"}</td>
                <td className="py-2">{u.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p className="py-6 text-center text-sm text-stone-500">No matching users.</p>}
        {users.length === 100 && <p className="pt-3 text-xs text-stone-500">Showing the newest 100. Narrow the search to see more.</p>}
      </div>
    </section>
  );
}
