import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraformPlan } from "../parsers/terraform/plan-parser.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { SUPPORTED_CURRENCIES, convertCurrency } from "../currency.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const analyzePlanSchema = z.object({
  plan_json: z
    .string()
    .describe("Output of 'terraform show -json <planfile>' or 'terraform plan -json'"),
  provider: z
    .enum(["aws", "azure", "gcp"])
    .optional()
    .describe("Target provider for cost estimation. If omitted, auto-detected from plan."),
  region: z
    .string()
    .optional()
    .describe("Target region. If omitted, detected from plan resources."),
  currency: z.enum(SUPPORTED_CURRENCIES).optional().default("USD").describe("Output currency"),
});

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PlanCostResourceDiff {
  address: string;
  resource_type: string;
  action: "create" | "update" | "delete" | "replace" | "no-op";
  before_monthly: number;
  after_monthly: number;
  delta_monthly: number;
  currency: string;
}

export interface AnalyzePlanResult {
  provider: CloudProvider;
  region: string;
  currency: string;
  total_before_monthly: number;
  total_after_monthly: number;
  total_delta_monthly: number;
  summary: {
    creates: number;
    updates: number;
    deletes: number;
    no_ops: number;
    replaces: number;
  };
  resource_diffs: PlanCostResourceDiff[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse a Terraform plan JSON, calculate before/after costs, and return a
 * cost-of-change analysis showing the delta for each resource.
 */
export async function analyzePlan(
  params: z.infer<typeof analyzePlanSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig,
): Promise<AnalyzePlanResult> {
  const analysis = parseTerraformPlan(params.plan_json);

  const targetProvider: CloudProvider =
    (params.provider as CloudProvider | undefined) ?? analysis.after.provider;

  const targetRegion =
    params.region ?? mapRegion(analysis.after.region, analysis.after.provider, targetProvider);

  const costEngine = new CostEngine(pricingEngine, config);

  // Calculate before and after costs in parallel
  const [beforeBreakdown, afterBreakdown] = await Promise.all([
    analysis.before.resources.length > 0
      ? costEngine.calculateBreakdown(analysis.before.resources, targetProvider, targetRegion)
      : null,
    analysis.after.resources.length > 0
      ? costEngine.calculateBreakdown(analysis.after.resources, targetProvider, targetRegion)
      : null,
  ]);

  const currency = params.currency ?? "USD";
  const warnings: string[] = [
    ...analysis.before.parse_warnings,
    ...analysis.after.parse_warnings,
    ...(beforeBreakdown?.warnings ?? []),
    ...(afterBreakdown?.warnings ?? []),
  ];

  // Build per-resource cost lookup maps from breakdowns
  const beforeCostMap = new Map<string, number>();
  if (beforeBreakdown) {
    for (const est of beforeBreakdown.by_resource) {
      beforeCostMap.set(est.resource_id, est.monthly_cost);
    }
  }

  const afterCostMap = new Map<string, number>();
  if (afterBreakdown) {
    for (const est of afterBreakdown.by_resource) {
      afterCostMap.set(est.resource_id, est.monthly_cost);
    }
  }

  // Build per-resource diffs aligned to plan changes
  const resourceDiffs: PlanCostResourceDiff[] = [];
  for (const change of analysis.changes) {
    const beforeMonthly = beforeCostMap.get(change.address) ?? 0;
    const afterMonthly = afterCostMap.get(change.address) ?? 0;
    const delta = afterMonthly - beforeMonthly;

    resourceDiffs.push({
      address: change.address,
      resource_type: change.type,
      action: change.action,
      before_monthly: round2(beforeMonthly),
      after_monthly: round2(afterMonthly),
      delta_monthly: round2(delta),
      currency: "USD",
    });
  }

  const totalBefore = beforeBreakdown?.total_monthly ?? 0;
  const totalAfter = afterBreakdown?.total_monthly ?? 0;

  let result: AnalyzePlanResult = {
    provider: targetProvider,
    region: targetRegion,
    currency: "USD",
    total_before_monthly: round2(totalBefore),
    total_after_monthly: round2(totalAfter),
    total_delta_monthly: round2(totalAfter - totalBefore),
    summary: analysis.summary,
    resource_diffs: resourceDiffs,
    warnings: [...new Set(warnings)],
  };

  // Apply currency conversion if requested
  if (currency !== "USD") {
    result = applyResultCurrency(result, currency);
  }

  logger.debug("analyzePlan complete", {
    provider: result.provider,
    region: result.region,
    totalBefore: result.total_before_monthly,
    totalAfter: result.total_after_monthly,
    delta: result.total_delta_monthly,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function applyResultCurrency(result: AnalyzePlanResult, currency: string): AnalyzePlanResult {
  return {
    ...result,
    currency,
    total_before_monthly: round2(convertCurrency(result.total_before_monthly, currency)),
    total_after_monthly: round2(convertCurrency(result.total_after_monthly, currency)),
    total_delta_monthly: round2(convertCurrency(result.total_delta_monthly, currency)),
    resource_diffs: result.resource_diffs.map((d) => ({
      ...d,
      currency,
      before_monthly: round2(convertCurrency(d.before_monthly, currency)),
      after_monthly: round2(convertCurrency(d.after_monthly, currency)),
      delta_monthly: round2(convertCurrency(d.delta_monthly, currency)),
    })),
  };
}
