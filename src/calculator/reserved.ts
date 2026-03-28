import type { CloudProvider } from "../types/resources.js";

/**
 * Represents a single reserved instance pricing option (term + payment model).
 */
export interface ReservedOption {
  term: "1yr" | "3yr";
  payment: "no_upfront" | "all_upfront" | "partial_upfront";
  monthly_cost: number;
  monthly_savings: number;
  percentage_savings: number;
}

/**
 * A full reserved-pricing comparison for a resource showing on-demand cost
 * alongside all available reserved purchase options.
 */
export interface ReservedComparison {
  on_demand_monthly: number;
  options: ReservedOption[];
  best_option: ReservedOption;
}

// Discount rates sourced from published provider documentation (approximate).
// AWS:   https://aws.amazon.com/ec2/pricing/reserved-instances/pricing/
// Azure: https://azure.microsoft.com/en-us/pricing/reserved-vm-instances/
// GCP:   https://cloud.google.com/compute/docs/sustained-use-discounts
const DISCOUNT_RATES: Record<
  CloudProvider,
  Array<{ term: "1yr" | "3yr"; payment: ReservedOption["payment"]; rate: number }>
> = {
  aws: [
    { term: "1yr", payment: "no_upfront", rate: 0.36 },
    { term: "1yr", payment: "partial_upfront", rate: 0.4 },
    { term: "1yr", payment: "all_upfront", rate: 0.42 },
    { term: "3yr", payment: "no_upfront", rate: 0.52 },
    { term: "3yr", payment: "partial_upfront", rate: 0.57 },
    { term: "3yr", payment: "all_upfront", rate: 0.6 },
  ],
  azure: [
    { term: "1yr", payment: "all_upfront", rate: 0.35 },
    { term: "3yr", payment: "all_upfront", rate: 0.55 },
    // Azure does not offer no-upfront RI in the same way; partial_upfront maps
    // to hybrid benefit combined, approximated here.
    { term: "1yr", payment: "partial_upfront", rate: 0.3 },
    { term: "3yr", payment: "partial_upfront", rate: 0.5 },
  ],
  gcp: [
    // GCP Committed Use Discounts (CUDs) – resource-based.
    { term: "1yr", payment: "all_upfront", rate: 0.28 },
    { term: "3yr", payment: "all_upfront", rate: 0.55 },
    { term: "1yr", payment: "partial_upfront", rate: 0.2 },
    { term: "3yr", payment: "partial_upfront", rate: 0.45 },
  ],
};

/**
 * Calculates reserved / committed-use pricing options for a resource given its
 * on-demand monthly cost.
 *
 * The returned comparison includes all available purchase options for the
 * provider plus a convenience best_option pointing to the highest-savings
 * all-upfront option.
 */
export function calculateReservedPricing(
  onDemandMonthly: number,
  provider: CloudProvider,
): ReservedComparison {
  const rates = DISCOUNT_RATES[provider];

  const options: ReservedOption[] = rates.map(({ term, payment, rate }) => {
    const monthly_cost = onDemandMonthly * (1 - rate);
    const monthly_savings = onDemandMonthly - monthly_cost;
    return {
      term,
      payment,
      monthly_cost: Math.round(monthly_cost * 100) / 100,
      monthly_savings: Math.round(monthly_savings * 100) / 100,
      percentage_savings: Math.round(rate * 1000) / 10, // e.g. 36.0
    };
  });

  // Best option = highest savings (last entry in our sorted-by-savings array).
  const best_option = options.reduce(
    (best, opt) => (opt.monthly_savings > best.monthly_savings ? opt : best),
    options[0],
  );

  return {
    on_demand_monthly: Math.round(onDemandMonthly * 100) / 100,
    options,
    best_option,
  };
}
