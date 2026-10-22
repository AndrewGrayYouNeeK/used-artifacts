import type { Db } from "@/lib/db";
import type { LedgerAccountKind } from "@/generated/prisma/enums";
import type { Tx } from "@/domains/audit/audit";

export interface AccountRef {
  code: string;
  kind: LedgerAccountKind;
}

/**
 * Chart of accounts. CASH is the platform's processor balance (an asset);
 * the others are liabilities or revenue, so a credit increases them.
 */
export const accounts = {
  cash: (): AccountRef => ({ code: "cash", kind: "CASH" }),
  platformRevenue: (): AccountRef => ({ code: "platform_revenue", kind: "PLATFORM_REVENUE" }),
  taxPayable: (): AccountRef => ({ code: "tax_payable", kind: "TAX_PAYABLE" }),
  processorFees: (): AccountRef => ({ code: "processor_fees", kind: "PROCESSOR_FEES" }),
  buyerHeld: (orderId: string): AccountRef => ({ code: `buyer_held:${orderId}`, kind: "BUYER_HELD" }),
  sellerPayable: (userId: string): AccountRef => ({ code: `seller_payable:${userId}`, kind: "SELLER_PAYABLE" }),
  referralPayable: (userId: string): AccountRef => ({ code: `referral_payable:${userId}`, kind: "REFERRAL_PAYABLE" }),
};

export interface Posting {
  debit: AccountRef;
  credit: AccountRef;
  amountCents: number;
  memo: string;
  orderId?: string;
  referralEarningId?: string;
}

async function accountId(tx: Tx, ref: AccountRef): Promise<string> {
  const row = await tx.ledgerAccount.upsert({
    where: { code: ref.code },
    create: { code: ref.code, kind: ref.kind },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/** Zero-amount postings are skipped; negative amounts are a bug. */
export async function post(tx: Tx, postings: Posting[]) {
  for (const p of postings) {
    if (!Number.isInteger(p.amountCents) || p.amountCents < 0) {
      throw new Error(`Invalid ledger amount ${p.amountCents} (${p.memo})`);
    }
    if (p.amountCents === 0) continue;
    await tx.ledgerEntry.create({
      data: {
        debitAccountId: await accountId(tx, p.debit),
        creditAccountId: await accountId(tx, p.credit),
        amountCents: p.amountCents,
        memo: p.memo,
        orderId: p.orderId ?? null,
        referralEarningId: p.referralEarningId ?? null,
      },
    });
  }
}

/** Credits minus debits: what the platform owes on a liability or revenue account. */
export async function creditBalance(db: Db | Tx, code: string): Promise<number> {
  const account = await db.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
  if (!account) return 0;
  const [credits, debits] = await Promise.all([
    db.ledgerEntry.aggregate({ where: { creditAccountId: account.id }, _sum: { amountCents: true } }),
    db.ledgerEntry.aggregate({ where: { debitAccountId: account.id }, _sum: { amountCents: true } }),
  ]);
  return (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
}

/** Balances of every account of one kind, summed (e.g. all seller payables). */
export async function kindCreditBalance(db: Db | Tx, kind: LedgerAccountKind): Promise<number> {
  const ids = (await db.ledgerAccount.findMany({ where: { kind }, select: { id: true } })).map((a) => a.id);
  if (ids.length === 0) return 0;
  const [credits, debits] = await Promise.all([
    db.ledgerEntry.aggregate({ where: { creditAccountId: { in: ids } }, _sum: { amountCents: true } }),
    db.ledgerEntry.aggregate({ where: { debitAccountId: { in: ids } }, _sum: { amountCents: true } }),
  ]);
  return (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
}
