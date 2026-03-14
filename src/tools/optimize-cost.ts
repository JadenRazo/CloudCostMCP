import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { CostEstimate } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { generateOptimizations } from "../calculator/optimizer.js";
import { calculateReservedPricing } from "../calculator/reserved.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const optimizeCostSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("File path"),
      content: z.string().describe("File content (HCL)"),
    })
  ),
  tfvars: z.string().optional().describe("Contents of terraform.tfvars file"),
  providers: z
    .array(z.enum(["aws", "azure", "gcp"]))
    .default(["aws", "azure", "gcp"])
    .describe("Providers to calculate costs against for cross-provider recommendations"),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse the supplied Terraform files, calculate costs across all requested
 * providers, and return optimisation recommendations together with reserved
 * pricing comparisons.
 */
export async function optimizeCost(
  params: z.infer<typeof optimizeCostSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig
): Promise<object> {
  const inventory = await parseTerraform(params.files, params.tfvars);
  const sourceProvider = inventory.provider;
  const costEngine = new CostEngine(pricingEngine, config);

  // Collect all cost estimates across every requested provider so the
  // optimizer can issue switch_provider recommendations when appropriate.
  const allEstimates: CostEstimate[] = [];

  for (const provider of params.providers as CloudProvider[]) {
    const targetRegion = mapRegion(inventory.region, sourceProvider, provider);
    const breakdown = await costEngine.calculateBreakdown(
      inventory.resources,
      provider,
      targetRegion
    );
    allEstimates.push(...breakdown.by_resource);
  }

  const recommendations = generateOptimizations(allEstimates, inventory.resources);

  // Build reserved pricing comparisons for every resource that has a non-zero
  // cost on the source provider so users can see committed-use savings at a
  // glance without navigating to a separate tool call.
  const sourceEstimates = allEstimates.filter(
    (e) => e.provider === sourceProvider && e.monthly_cost > 0
  );

  const reservedPricing = sourceEstimates.map((estimate) => ({
    resource_id: estimate.resource_id,
    resource_name: estimate.resource_name,
    resource_type: estimate.resource_type,
    provider: estimate.provider,
    ...calculateReservedPricing(estimate.monthly_cost, estimate.provider),
  }));

  const totalPotentialSavings =
    recommendations.reduce((sum, r) => sum + r.monthly_savings, 0);

  return {
    recommendations,
    reserved_pricing: reservedPricing,
    total_potential_savings: Math.round(totalPotentialSavings * 100) / 100,
  };
}
