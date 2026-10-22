/** Basis points: 100 bps = 1%. */
export interface FeeRates {
  buyerFeeBps: number;
  sellerFeeBps: number;
}

/**
 * Two-sided fee model (owner decision B3). The buyer fee is built into the
 * displayed price and checkout never adds a fee on top; the seller fee is
 * deducted from the asking price. Pure and env-free so the listing form can
 * show the same numbers client-side that checkout will charge.
 */
export interface PriceBreakdown {
  askingCents: number;
  buyerFeeCents: number;
  /** The only price a buyer ever sees, and exactly what they are charged for the item. */
  buyerPriceCents: number;
  sellerFeeCents: number;
  sellerPayoutCents: number;
  /** buyerFeeCents + sellerFeeCents. */
  platformFeeCents: number;
}

export function assertCents(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of cents`);
  }
}

export function applyBps(amountCents: number, rateBps: number): number {
  return Math.round((amountCents * rateBps) / 10_000);
}

export function priceBreakdown(askingCents: number, rates: FeeRates): PriceBreakdown {
  assertCents(askingCents, "askingCents");
  const buyerFeeCents = applyBps(askingCents, rates.buyerFeeBps);
  const sellerFeeCents = applyBps(askingCents, rates.sellerFeeBps);
  return {
    askingCents,
    buyerFeeCents,
    buyerPriceCents: askingCents + buyerFeeCents,
    sellerFeeCents,
    sellerPayoutCents: askingCents - sellerFeeCents,
    platformFeeCents: buyerFeeCents + sellerFeeCents,
  };
}

/**
 * The inverse of priceBreakdown, for auctions where bidders bid buyer prices:
 * splits a winning bid into the asking amount and the buyer fee so the buyer
 * pays exactly the bid. Rounding is absorbed by the buyer fee (at most 1 cent
 * off applyBps), and the seller fee is computed on the asking amount as usual.
 */
export function splitBuyerPrice(buyerPriceCents: number, rates: FeeRates): PriceBreakdown {
  assertCents(buyerPriceCents, "buyerPriceCents");
  const askingCents = Math.floor((buyerPriceCents * 10_000) / (10_000 + rates.buyerFeeBps));
  const buyerFeeCents = buyerPriceCents - askingCents;
  const sellerFeeCents = applyBps(askingCents, rates.sellerFeeBps);
  return {
    askingCents,
    buyerFeeCents,
    buyerPriceCents,
    sellerFeeCents,
    sellerPayoutCents: askingCents - sellerFeeCents,
    platformFeeCents: buyerFeeCents + sellerFeeCents,
  };
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Parses "1,234.5" / "$12" style input into cents; null if not a valid amount. */
export function parseUsdToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
