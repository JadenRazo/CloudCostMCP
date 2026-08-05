import type { CloudProvider, ParsedResource } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

/**
 * Rounds a currency amount to two decimal places (cents).
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface MakeCostEstimateInput {
  /** Source resource the estimate describes (id/type/name are copied over). */
  resource: Pick<ParsedResource, "id" | "type" | "name">;
  /** Target provider the cost was calculated for. */
  provider: CloudProvider;
  /** Target region the cost was calculated for. */
  region: string;
  /**
   * Total monthly cost, unrounded. The factory rounds both the monthly and
   * the derived yearly figure to cents.
   */
  monthlyCost: number;
  breakdown: CostLineItem[];
  confidence: CostEstimate["confidence"];
  notes: string[];
  pricingSource: CostEstimate["pricing_source"];
  /** Defaults to USD — every calculator prices in USD today. */
  currency?: string;
}

/**
 * Builds the standard CostEstimate object every calculator returns.
 *
 * Centralizing the literal keeps the field mapping in one place and
 * guarantees consistent cent-rounding of monthly_cost / yearly_cost
 * (yearly is rounded from the unrounded monthly figure, so it does not
 * accumulate the monthly rounding error twelve times).
 */
export function makeCostEstimate(input: MakeCostEstimateInput): CostEstimate {
  return {
    resource_id: input.resource.id,
    resource_type: input.resource.type,
    resource_name: input.resource.name,
    provider: input.provider,
    region: input.region,
    monthly_cost: round2(input.monthlyCost),
    yearly_cost: round2(input.monthlyCost * 12),
    currency: input.currency ?? "USD",
    breakdown: input.breakdown,
    confidence: input.confidence,
    notes: input.notes,
    pricing_source: input.pricingSource,
  };
}
