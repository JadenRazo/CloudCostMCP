import { z } from "zod";
import type { PricingCache } from "../pricing/cache.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const priceTrendsSchema = z.object({
  provider: z.enum(["aws", "azure", "gcp"]).describe("Cloud provider"),
  service: z.string().describe("Service category (e.g., ec2, rds, virtual-machines)"),
  resource_type: z.string().describe("Resource type (e.g., t3.large, Standard_D2s_v5)"),
  region: z.string().describe("Cloud region"),
  limit: z.number().optional().default(30).describe("Max number of price points to return"),
  since: z.string().optional().describe("ISO date to start from (e.g., 2024-01-01)"),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Query historical price trends for a specific cloud resource. Returns the
 * recorded price history, the most recent price change, and summary metadata.
 */
export function priceTrends(
  params: z.infer<typeof priceTrendsSchema>,
  cache: PricingCache,
): object {
  const { provider, service, resource_type, region, limit, since } = params;

  const history = cache.getPriceHistory(provider, service, resource_type, region, {
    limit,
    since,
  });

  const priceChange = cache.getPriceChange(provider, service, resource_type, region);

  const currentPrice =
    history.length > 0
      ? { price_per_unit: history[0].price_per_unit, unit: history[0].unit }
      : null;

  return {
    provider,
    service,
    resource_type,
    region,
    current_price: currentPrice,
    price_history: history,
    price_change: priceChange,
    data_points: history.length,
  };
}
