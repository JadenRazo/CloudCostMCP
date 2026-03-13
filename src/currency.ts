import type { CostBreakdown, CostEstimate, CostLineItem } from "./types/pricing.js";

// ---------------------------------------------------------------------------
// Supported currencies and exchange rates
// ---------------------------------------------------------------------------

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "BRL"] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

// Static exchange rates (approximate, as of March 2026)
const EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.50,
  CAD: 1.36,
  AUD: 1.53,
  INR: 83.10,
  BRL: 4.97,
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
  INR: "₹",
  BRL: "R$",
};

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Convert a USD amount to the target currency using static exchange rates.
 * Returns the original amount unchanged when the target is USD or unknown.
 */
export function convertCurrency(amountUsd: number, targetCurrency: string): number {
  const rate = EXCHANGE_RATES[targetCurrency];
  if (rate === undefined || rate === 1.0) {
    return amountUsd;
  }
  return amountUsd * rate;
}

/**
 * Return the currency symbol for a given currency code.
 * Falls back to the currency code itself when no symbol is registered.
 */
export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

/**
 * Format a numeric amount for display, respecting currency-specific decimal
 * conventions. JPY uses zero decimal places; all others use two.
 */
export function formatCurrency(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency);
  const decimals = currency === "JPY" ? 0 : 2;
  const formatted = amount.toFixed(decimals);
  return `${symbol}${formatted}`;
}

// ---------------------------------------------------------------------------
// Breakdown conversion
// ---------------------------------------------------------------------------

interface ConvertedBreakdown extends CostBreakdown {
  currency: string;
  original_usd: {
    total_monthly: number;
    total_yearly: number;
  };
}

function convertLineItem(item: CostLineItem, currency: string): CostLineItem {
  return {
    ...item,
    unit_price: convertCurrency(item.unit_price, currency),
    monthly_cost: convertCurrency(item.monthly_cost, currency),
  };
}

function convertCostEstimate(estimate: CostEstimate, currency: string): CostEstimate {
  return {
    ...estimate,
    monthly_cost: convertCurrency(estimate.monthly_cost, currency),
    yearly_cost: convertCurrency(estimate.yearly_cost, currency),
    currency,
    breakdown: estimate.breakdown.map((item) => convertLineItem(item, currency)),
  };
}

/**
 * Convert all cost fields within a CostBreakdown to the target currency.
 * The original USD totals are preserved under the `original_usd` key so
 * callers can always trace back to the source figures.
 */
export function convertBreakdownCurrency(
  breakdown: CostBreakdown,
  currency: string
): ConvertedBreakdown {
  const original_usd = {
    total_monthly: breakdown.total_monthly,
    total_yearly: breakdown.total_yearly,
  };

  const convertedByService: Record<string, number> = {};
  for (const [service, amount] of Object.entries(breakdown.by_service)) {
    convertedByService[service] = convertCurrency(amount, currency);
  }

  return {
    ...breakdown,
    total_monthly: convertCurrency(breakdown.total_monthly, currency),
    total_yearly: convertCurrency(breakdown.total_yearly, currency),
    currency,
    by_service: convertedByService,
    by_resource: breakdown.by_resource.map((est) => convertCostEstimate(est, currency)),
    original_usd,
  };
}
