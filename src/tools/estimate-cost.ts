import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { SUPPORTED_CURRENCIES, convertBreakdownCurrency } from "../currency.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const estimateCostSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("File path"),
      content: z.string().describe("File content (HCL)"),
    })
  ),
  tfvars: z.string().optional().describe("Contents of terraform.tfvars file"),
  provider: z
    .enum(["aws", "azure", "gcp"])
    .describe("Target cloud provider to estimate costs for"),
  region: z
    .string()
    .optional()
    .describe(
      "Target region for pricing lookup. Defaults to the source region mapped to the target provider."
    ),
  currency: z
    .enum(SUPPORTED_CURRENCIES)
    .optional()
    .default("USD")
    .describe("Output currency for cost estimates. Defaults to USD."),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse the supplied Terraform files, map resources to the target provider,
 * and return a full CostBreakdown for that provider.
 */
export async function estimateCost(
  params: z.infer<typeof estimateCostSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig
): Promise<object> {
  const inventory = await parseTerraform(params.files, params.tfvars);

  const targetProvider = params.provider as CloudProvider;

  // Resolve the target region: use the explicit override if supplied,
  // otherwise map the source region to the nearest equivalent on the target
  // provider.
  const targetRegion =
    params.region ??
    mapRegion(inventory.region, inventory.provider, targetProvider);

  const costEngine = new CostEngine(pricingEngine, config);
  const breakdown = await costEngine.calculateBreakdown(
    inventory.resources,
    targetProvider,
    targetRegion
  );

  // Surface parse warnings alongside the cost breakdown so callers have a
  // complete picture of data quality for this estimate.
  const parseWarnings = inventory.parse_warnings ?? [];
  const allWarnings = [...new Set([...parseWarnings, ...(breakdown.warnings ?? [])])];

  const currency = params.currency ?? "USD";
  const converted = currency !== "USD" ? convertBreakdownCurrency(breakdown, currency) : breakdown;

  return {
    ...converted,
    parse_warnings: parseWarnings,
    warnings: allWarnings,
  } as unknown as object;
}
