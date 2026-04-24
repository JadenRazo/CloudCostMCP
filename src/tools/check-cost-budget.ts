import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { SUPPORTED_CURRENCIES, convertBreakdownCurrency } from "../currency.js";
import {
  filePathSchema,
  fileContentSchema,
  tfvarsSchema,
  shortStringSchema,
  assertTotalFileBytesWithin,
} from "../schemas/bounded.js";
import { sanitizeForMessage } from "../util/sanitize.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const checkCostBudgetSchema = z.object({
  files: z
    .array(
      z.object({
        path: filePathSchema.describe("File path"),
        content: fileContentSchema.describe("File content"),
      }),
    )
    .max(2000, "files array exceeds 2000 entries")
    .superRefine(assertTotalFileBytesWithin)
    .describe("IaC files to evaluate (Terraform, CloudFormation, Pulumi, or Bicep/ARM)"),
  tfvars: tfvarsSchema.optional().describe("Variable overrides for Terraform"),
  provider: z
    .enum(["aws", "azure", "gcp"])
    .optional()
    .describe(
      "Target cloud provider. Defaults to the provider detected in the files; if no provider can be detected and none is passed, the call returns a structured error rather than silently picking AWS.",
    ),
  region: shortStringSchema
    .optional()
    .describe("Target region. Defaults to the region detected in the files."),
  currency: z
    .enum(SUPPORTED_CURRENCIES)
    .optional()
    .default("USD")
    .describe("Currency for the threshold comparisons and output. Defaults to USD."),
  max_monthly: z
    .number()
    .positive()
    .finite()
    .optional()
    .describe(
      "Aggregate monthly spend threshold. If the estimated total exceeds this, verdict is 'block'. Falls back to CLOUDCOST_GUARDRAIL_MAX_MONTHLY env var, then CLOUDCOST_BUDGET_MONTHLY.",
    ),
  max_per_resource: z
    .number()
    .positive()
    .finite()
    .optional()
    .describe(
      "Per-resource monthly cost threshold. Any single resource above this forces a 'block' verdict. Falls back to CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE env var, then CLOUDCOST_BUDGET_PER_RESOURCE.",
    ),
  warn_ratio: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe(
      "Fraction of a threshold at which to emit 'warn' rather than 'allow'. Must be > 0 and ≤ 1. Default 0.8 (warn at 80%).",
    ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Verdict = "allow" | "warn" | "block";
type ThresholdSource = "params" | "config" | "budget" | "none";

export interface ResourceVerdict {
  resource_id: string;
  resource_type: string;
  monthly_cost: number;
  threshold: number;
  reason: string;
}

export interface CheckCostBudgetResult {
  verdict: Verdict;
  total_monthly: number;
  currency: string;
  resource_count: number;
  thresholds: {
    max_monthly?: number;
    max_per_resource?: number;
    warn_ratio: number;
    source: {
      max_monthly: ThresholdSource;
      max_per_resource: ThresholdSource;
    };
  };
  reasons: string[];
  blocking_resources: ResourceVerdict[];
  warning_resources: ResourceVerdict[];
  summary: string;
  /** Error flag set when input could not be evaluated (e.g. ambiguous provider). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

interface ResolvedThresholds {
  max_monthly?: number;
  max_per_resource?: number;
  warn_ratio: number;
  source: { max_monthly: ThresholdSource; max_per_resource: ThresholdSource };
}

function pickThreshold(
  fromParams: number | undefined,
  fromConfig: number | undefined,
  fromBudget: number | undefined,
): { value?: number; source: ThresholdSource } {
  if (fromParams != null) return { value: fromParams, source: "params" };
  if (fromConfig != null) return { value: fromConfig, source: "config" };
  if (fromBudget != null) return { value: fromBudget, source: "budget" };
  return { value: undefined, source: "none" };
}

function resolveThresholds(
  params: z.infer<typeof checkCostBudgetSchema>,
  config: CloudCostConfig,
): ResolvedThresholds {
  const guardrail = config.guardrail ?? {};
  const budget = config.budget ?? {};

  const monthly = pickThreshold(params.max_monthly, guardrail.max_monthly, budget.monthly_limit);
  const perResource = pickThreshold(
    params.max_per_resource,
    guardrail.max_per_resource,
    budget.per_resource_limit,
  );

  return {
    max_monthly: monthly.value,
    max_per_resource: perResource.value,
    warn_ratio: params.warn_ratio ?? guardrail.warn_ratio ?? 0.8,
    source: { max_monthly: monthly.source, max_per_resource: perResource.source },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Cost-safety guardrail consumable by an agent mid-generation.
 *
 * Returns allow / warn / block with blocking_resources and warning_resources
 * populated so the caller can decide whether to proceed with a write.
 */
export async function checkCostBudget(
  params: z.infer<typeof checkCostBudgetSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig,
): Promise<CheckCostBudgetResult> {
  const thresholds = resolveThresholds(params, config);
  const currency = params.currency ?? "USD";

  const inventory = await parseTerraform(params.files, params.tfvars);

  // Refuse to silently default to AWS when no provider can be inferred.
  // A false "allow" here (wrong-provider pricing) is worse than a loud error.
  const resolvedProvider = params.provider ?? inventory.provider;
  if (!resolvedProvider) {
    return {
      verdict: "block",
      total_monthly: 0,
      currency,
      resource_count: inventory.resources.length,
      thresholds,
      reasons: [
        "provider could not be determined from the input — pass `provider` explicitly (aws|azure|gcp)",
      ],
      blocking_resources: [],
      warning_resources: [],
      summary: "block: provider could not be determined",
      error: "provider_unresolved",
    };
  }
  const targetProvider = resolvedProvider as CloudProvider;
  const targetRegion =
    params.region ?? mapRegion(inventory.region, inventory.provider, targetProvider);

  const costEngine = new CostEngine(pricingEngine, config);
  let breakdown = await costEngine.calculateBreakdown(
    inventory.resources,
    targetProvider,
    targetRegion,
  );

  if (currency !== "USD") {
    breakdown = convertBreakdownCurrency(breakdown, currency);
  }

  const totalMonthly = breakdown.total_monthly;
  const resourceCount = breakdown.by_resource.length;

  // Non-finite total → fail closed. A silently-NaN total compares false against
  // any threshold and would otherwise produce a deceptive "allow".
  if (!Number.isFinite(totalMonthly)) {
    return {
      verdict: "block",
      total_monthly: 0,
      currency,
      resource_count: resourceCount,
      thresholds,
      reasons: ["total cost computed as non-finite value — internal pricing error"],
      blocking_resources: [],
      warning_resources: [],
      summary: "block: non-finite total cost",
      error: "non_finite_total",
    };
  }

  const blocking: ResourceVerdict[] = [];
  const warning: ResourceVerdict[] = [];
  const reasons: string[] = [];

  // No thresholds anywhere → allow with a hint so the caller knows why.
  if (thresholds.max_monthly == null && thresholds.max_per_resource == null) {
    return {
      verdict: "allow",
      total_monthly: totalMonthly,
      currency,
      resource_count: resourceCount,
      thresholds,
      reasons: [
        "no budget thresholds configured — pass max_monthly / max_per_resource or set CLOUDCOST_GUARDRAIL_MAX_MONTHLY / CLOUDCOST_GUARDRAIL_MAX_PER_RESOURCE",
      ],
      blocking_resources: [],
      warning_resources: [],
      summary: `allow: no thresholds configured (${resourceCount} resources, ${formatMoney(totalMonthly, currency)}/mo)`,
    };
  }

  // Aggregate check
  const totalOver = thresholds.max_monthly != null && totalMonthly > thresholds.max_monthly;
  const totalWarn =
    !totalOver &&
    thresholds.max_monthly != null &&
    totalMonthly >= thresholds.max_monthly * thresholds.warn_ratio;

  if (totalOver) {
    reasons.push(
      `total ${formatMoney(totalMonthly, currency)}/mo exceeds threshold ${formatMoney(thresholds.max_monthly!, currency)}/mo`,
    );
  } else if (totalWarn) {
    const pct = Math.round((totalMonthly / thresholds.max_monthly!) * 100);
    reasons.push(
      `total ${formatMoney(totalMonthly, currency)}/mo is ${pct}% of threshold ${formatMoney(thresholds.max_monthly!, currency)}/mo`,
    );
  }

  // Per-resource check
  if (thresholds.max_per_resource != null) {
    for (const est of breakdown.by_resource) {
      if (!Number.isFinite(est.monthly_cost)) continue;
      // Sanitise IDs that originated from user IaC — the MCP response is read
      // by an LLM, and control chars / bidi overrides / oversized strings in
      // resource identifiers would otherwise become a prompt-injection vector.
      const safeId = sanitizeForMessage(est.resource_id, 256);
      const safeType = sanitizeForMessage(est.resource_type, 128);
      if (est.monthly_cost > thresholds.max_per_resource) {
        blocking.push({
          resource_id: safeId,
          resource_type: safeType,
          monthly_cost: est.monthly_cost,
          threshold: thresholds.max_per_resource,
          reason: `${formatMoney(est.monthly_cost, currency)}/mo exceeds per-resource limit ${formatMoney(thresholds.max_per_resource, currency)}/mo`,
        });
      } else if (est.monthly_cost >= thresholds.max_per_resource * thresholds.warn_ratio) {
        const pct = Math.round((est.monthly_cost / thresholds.max_per_resource) * 100);
        warning.push({
          resource_id: safeId,
          resource_type: safeType,
          monthly_cost: est.monthly_cost,
          threshold: thresholds.max_per_resource,
          reason: `${formatMoney(est.monthly_cost, currency)}/mo is ${pct}% of per-resource limit ${formatMoney(thresholds.max_per_resource, currency)}/mo`,
        });
      }
    }
  }

  // Verdict
  let verdict: Verdict = "allow";
  if (totalOver || blocking.length > 0) {
    verdict = "block";
  } else if (totalWarn || warning.length > 0) {
    verdict = "warn";
  }

  // Summary
  const summaryParts: string[] = [
    `${verdict}: ${formatMoney(totalMonthly, currency)}/mo across ${resourceCount} resource${resourceCount === 1 ? "" : "s"}`,
  ];
  if (totalOver) {
    summaryParts.push(`total over threshold ${formatMoney(thresholds.max_monthly!, currency)}`);
  }
  if (blocking.length) {
    summaryParts.push(
      `${blocking.length} resource${blocking.length === 1 ? "" : "s"} over per-resource limit`,
    );
  }
  if (warning.length) {
    summaryParts.push(
      `${warning.length} resource${warning.length === 1 ? "" : "s"} near per-resource limit`,
    );
  }

  return {
    verdict,
    total_monthly: totalMonthly,
    currency,
    resource_count: resourceCount,
    thresholds,
    reasons,
    blocking_resources: blocking,
    warning_resources: warning,
    summary: summaryParts.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMoney(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${safe.toFixed(2)}`;
}
