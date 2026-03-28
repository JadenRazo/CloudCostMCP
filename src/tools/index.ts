import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CloudCostConfig } from "../types/config.js";
import { PricingCache } from "../pricing/cache.js";
import { PricingEngine } from "../pricing/pricing-engine.js";

import { analyzeTerraformSchema, analyzeTerraform } from "./analyze-terraform.js";
import { estimateCostSchema, estimateCost } from "./estimate-cost.js";
import { compareProvidersSchema, compareProviders } from "./compare-providers.js";
import { getEquivalentsSchema, getEquivalents } from "./get-equivalents.js";
import { getPricingSchema, getPricing } from "./get-pricing.js";
import { optimizeCostSchema, optimizeCost } from "./optimize-cost.js";
import { whatIfSchema, whatIf } from "./what-if.js";
import { analyzePlanSchema, analyzePlan } from "./analyze-plan.js";
import { compareActualSchema, compareActual } from "./compare-actual.js";
import { priceTrendsSchema, priceTrends } from "./price-trends.js";
import { detectAnomaliesSchema, detectAnomalies } from "./detect-anomalies.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all CloudCost MCP tools on the provided McpServer instance.
 *
 * A single PricingCache and PricingEngine are shared across all tools so
 * that the SQLite cache is opened exactly once per server lifetime.
 */
export function registerTools(server: McpServer, config: CloudCostConfig): void {
  const cache = new PricingCache(config.cache.db_path);
  const pricingEngine = new PricingEngine(cache, config);

  // -------------------------------------------------------------------------
  // analyze_terraform
  // -------------------------------------------------------------------------
  server.tool(
    "analyze_terraform",
    "Parse Terraform HCL files and extract a resource inventory with provider detection, variable resolution, and cost-relevant attribute extraction",
    analyzeTerraformSchema.shape,
    async (params) => {
      const result = await analyzeTerraform(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // estimate_cost
  // -------------------------------------------------------------------------
  server.tool(
    "estimate_cost",
    "Estimate monthly and yearly cloud costs for Terraform resources on a specific provider. Returns a full cost breakdown by resource and service category.",
    estimateCostSchema.shape,
    async (params) => {
      const result = await estimateCost(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // compare_providers
  // -------------------------------------------------------------------------
  server.tool(
    "compare_providers",
    "Run a full cost comparison across AWS, Azure, and GCP for a set of Terraform resources. Returns a formatted report and raw comparison data including savings potential.",
    compareProvidersSchema.shape,
    async (params) => {
      const result = await compareProviders(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_equivalents
  // -------------------------------------------------------------------------
  server.tool(
    "get_equivalents",
    "Look up the equivalent Terraform resource types across cloud providers. Optionally also maps an instance type / VM size to the nearest equivalent on target providers.",
    getEquivalentsSchema.shape,
    async (params) => {
      const result = await getEquivalents(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_pricing
  // -------------------------------------------------------------------------
  server.tool(
    "get_pricing",
    "Direct pricing lookup for a specific cloud provider, service, resource type, and region. Returns the normalised unit price with metadata.",
    getPricingSchema.shape,
    async (params) => {
      const result = await getPricing(params, pricingEngine);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // optimize_cost
  // -------------------------------------------------------------------------
  server.tool(
    "optimize_cost",
    "Analyse Terraform resources and return cost optimisation recommendations including right-sizing suggestions, reserved pricing comparisons, and cross-provider savings opportunities.",
    optimizeCostSchema.shape,
    async (params) => {
      const result = await optimizeCost(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // what_if
  // -------------------------------------------------------------------------
  server.tool(
    "what_if",
    "Estimate cost impact of infrastructure changes without modifying Terraform files. Applies attribute overrides to a cloned resource set and returns a per-resource and aggregate cost diff.",
    whatIfSchema.shape,
    async (params) => {
      const result = await whatIf(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // analyze_plan
  // -------------------------------------------------------------------------
  server.tool(
    "analyze_plan",
    "Parse Terraform plan JSON (from 'terraform show -json' or 'terraform plan -json') and return a cost-of-change analysis showing before/after costs and per-resource deltas.",
    analyzePlanSchema.shape,
    async (params) => {
      const result = await analyzePlan(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // compare_actual
  // -------------------------------------------------------------------------
  server.tool(
    "compare_actual",
    "Parse a Terraform state file (.tfstate) and calculate actual infrastructure costs. Optionally compare against planned costs from HCL files to show drift.",
    compareActualSchema.shape,
    async (params) => {
      const result = await compareActual(params, pricingEngine, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // price_trends
  // -------------------------------------------------------------------------
  server.tool(
    "price_trends",
    "Query historical pricing trends for a specific cloud resource. Returns recorded price history, the most recent price change, and summary metadata.",
    priceTrendsSchema.shape,
    (params) => {
      const result = priceTrends(params, cache);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // detect_anomalies
  // -------------------------------------------------------------------------
  server.tool(
    "detect_anomalies",
    "Analyze infrastructure costs and flag anomalies — resources whose estimated costs are unusual compared to historical baselines or configured thresholds.",
    detectAnomaliesSchema.shape,
    async (params) => {
      const result = await detectAnomalies(params, pricingEngine, cache, config);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
