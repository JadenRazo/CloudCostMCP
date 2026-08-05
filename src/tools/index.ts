import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ZodRawShape, ZodObject, infer as ZodInfer } from "zod";
import type { CloudCostConfig } from "../types/config.js";
import { PricingCache } from "../pricing/cache.js";
import { PricingEngine } from "../pricing/pricing-engine.js";
import { logger } from "../logger.js";

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
import { checkCostBudgetSchema, checkCostBudget } from "./check-cost-budget.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function jsonResult(value: unknown, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Registers one tool via the SDK's registerTool API with the shared
 * conventions applied:
 *  - annotations.readOnlyHint — every CloudCost tool is read-only (none
 *    mutate infrastructure or files),
 *  - JSON-text result envelope (clients parse content[0].text as JSON),
 *  - per-tool try/catch: a thrown error becomes {error: message} with
 *    isError: true instead of a protocol-level failure,
 *  - optional resultIsError predicate so tools that return structured
 *    error objects (rather than throwing) also flag isError.
 */
function registerJsonTool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: ZodObject<Shape>,
  handler: (params: ZodInfer<ZodObject<Shape>>) => unknown,
  resultIsError?: (result: unknown) => boolean,
): void {
  server.registerTool<ZodRawShapeCompat, ZodRawShapeCompat>(
    name,
    {
      description,
      inputSchema: schema.shape,
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const result = await handler(params as ZodInfer<ZodObject<Shape>>);
        return jsonResult(result, resultIsError?.(result) ?? false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`tool ${name} failed`, { error: message });
        return jsonResult({ error: message }, true);
      }
    },
  );
}

/**
 * Register all CloudCost MCP tools on the provided McpServer instance.
 *
 * A single PricingCache and PricingEngine are shared across all tools so
 * that the SQLite cache is opened exactly once per server lifetime.
 *
 * Returns a close hook that releases the shared PricingCache (SQLite
 * handle); call it on server shutdown.
 */
export function registerTools(server: McpServer, config: CloudCostConfig): () => void {
  const cache = new PricingCache(config.cache.db_path);
  const pricingEngine = new PricingEngine(cache, config);

  registerJsonTool(
    server,
    "analyze_terraform",
    "Parse Terraform HCL files and extract a resource inventory with provider detection, variable resolution, and cost-relevant attribute extraction",
    analyzeTerraformSchema,
    (params) => analyzeTerraform(params),
  );

  registerJsonTool(
    server,
    "estimate_cost",
    "Estimate monthly and yearly cloud costs for Terraform resources on a specific provider. Returns a full cost breakdown by resource and service category.",
    estimateCostSchema,
    (params) => estimateCost(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "compare_providers",
    "Run a full cost comparison across AWS, Azure, and GCP for a set of Terraform resources. Returns a formatted report and raw comparison data including savings potential.",
    compareProvidersSchema,
    (params) => compareProviders(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "get_equivalents",
    "Look up the equivalent Terraform resource types across cloud providers. Optionally also maps an instance type / VM size to the nearest equivalent on target providers.",
    getEquivalentsSchema,
    (params) => getEquivalents(params),
  );

  registerJsonTool(
    server,
    "get_pricing",
    "Direct pricing lookup for a specific cloud provider, service, resource type, and region. Returns the normalised unit price with metadata.",
    getPricingSchema,
    (params) => getPricing(params, pricingEngine),
  );

  registerJsonTool(
    server,
    "optimize_cost",
    "Analyse Terraform resources and return cost optimisation recommendations including right-sizing suggestions, reserved pricing comparisons, and cross-provider savings opportunities.",
    optimizeCostSchema,
    (params) => optimizeCost(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "what_if",
    "Estimate cost impact of infrastructure changes without modifying Terraform files. Applies attribute overrides to a cloned resource set and returns a per-resource and aggregate cost diff.",
    whatIfSchema,
    (params) => whatIf(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "analyze_plan",
    "Parse Terraform plan JSON (from 'terraform show -json' or 'terraform plan -json') and return a cost-of-change analysis showing before/after costs and per-resource deltas.",
    analyzePlanSchema,
    (params) => analyzePlan(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "compare_actual",
    "Parse a Terraform state file (.tfstate) and calculate actual infrastructure costs. Optionally compare against planned costs from HCL files to show drift.",
    compareActualSchema,
    (params) => compareActual(params, pricingEngine, config),
  );

  registerJsonTool(
    server,
    "price_trends",
    "Query historical pricing trends for a specific cloud resource. Returns recorded price history, the most recent price change, and summary metadata.",
    priceTrendsSchema,
    (params) => priceTrends(params, cache),
  );

  registerJsonTool(
    server,
    "detect_anomalies",
    "Analyze infrastructure costs and flag anomalies — resources whose estimated costs are unusual compared to historical baselines or configured thresholds.",
    detectAnomaliesSchema,
    (params) => detectAnomalies(params, pricingEngine, cache, config),
  );

  registerJsonTool(
    server,
    "check_cost_budget",
    "Agent-ready cost guardrail. Returns allow / warn / block with blocking_resources so an AI agent can veto an expensive IaC write before committing. Thresholds cascade: per-call params > CLOUDCOST_GUARDRAIL_* env > CLOUDCOST_BUDGET_* env > no-op allow.",
    checkCostBudgetSchema,
    (params) => checkCostBudget(params, pricingEngine, config),
    // check_cost_budget returns structured errors (error: "provider_unresolved"
    // | "non_finite_total") instead of throwing; surface those as isError too.
    (result) =>
      typeof result === "object" &&
      result !== null &&
      typeof (result as { error?: unknown }).error === "string",
  );

  return () => {
    cache.close();
  };
}
