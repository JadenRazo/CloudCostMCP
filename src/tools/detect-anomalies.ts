import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import type { PricingCache } from "../pricing/cache.js";
import type { CostEstimate } from "../types/pricing.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { SUPPORTED_CURRENCIES } from "../currency.js";
import { filePathSchema, fileContentSchema, tfvarsSchema } from "../schemas/bounded.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const detectAnomaliesSchema = z.object({
  files: z
    .array(
      z.object({
        path: filePathSchema.describe("File path"),
        content: fileContentSchema.describe("File content"),
      }),
    )
    .max(2000, "files array exceeds 2000 entries"),
  tfvars: tfvarsSchema.optional().describe("Variable overrides"),
  provider: z.enum(["aws", "azure", "gcp"]).describe("Target cloud provider"),
  region: z.string().optional().describe("Target region"),
  currency: z
    .enum(SUPPORTED_CURRENCIES)
    .optional()
    .default("USD")
    .describe("Output currency for cost estimates. Defaults to USD."),
  budget_monthly: z.number().optional().describe("Monthly budget threshold in USD"),
  budget_per_resource: z.number().optional().describe("Per-resource cost threshold in USD"),
  price_change_threshold: z
    .number()
    .optional()
    .default(10)
    .describe("Alert on price changes exceeding this percentage"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Anomaly {
  type: "budget_exceeded" | "price_change" | "cost_concentration" | "potential_oversizing";
  severity: "high" | "medium" | "low";
  resource: string;
  resource_type: string;
  message: string;
  details: {
    current_cost?: number;
    threshold?: number;
    price_change_percent?: number;
    cost_share_percent?: number;
  };
}

interface AnomalyResult {
  total_monthly: number;
  anomalies: Anomaly[];
  summary: {
    total_resources: number;
    anomaly_count: number;
    high_severity: number;
    medium_severity: number;
    low_severity: number;
  };
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Instance size classification
// ---------------------------------------------------------------------------

/** Minimum vCPU thresholds for Azure/GCP numeric patterns to be "xlarge". */
const MIN_VCPUS_FOR_OVERSIZING = 8;

function isOversizedInstance(instanceType: string | undefined): boolean {
  if (!instanceType) return false;

  // AWS-style: anything with "xlarge" in the name
  if (/xlarge/i.test(instanceType)) return true;

  // Azure D/E/F series: extract the vCPU count from the name
  const azureMatch = instanceType.match(/Standard_[A-Z](\d+)s?_v\d+/i);
  if (azureMatch) {
    const vcpus = parseInt(azureMatch[1], 10);
    return vcpus >= MIN_VCPUS_FOR_OVERSIZING;
  }

  // GCP machine types: extract vCPU count suffix
  const gcpMatch = instanceType.match(/(?:n1|n2|n2d|c2|e2)-(?:standard|highmem|highcpu)-(\d+)/);
  if (gcpMatch) {
    const vcpus = parseInt(gcpMatch[1], 10);
    return vcpus >= MIN_VCPUS_FOR_OVERSIZING;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Service label for price-change lookups
// ---------------------------------------------------------------------------

function serviceLabelForType(resourceType: string): string {
  if (resourceType.startsWith("aws_instance") || resourceType.startsWith("aws_eks_node_group"))
    return "ec2";
  if (
    resourceType.startsWith("azurerm_linux_virtual_machine") ||
    resourceType.startsWith("azurerm_windows_virtual_machine")
  )
    return "virtual-machines";
  if (
    resourceType.startsWith("google_compute_instance") ||
    resourceType.startsWith("google_container_node_pool")
  )
    return "compute-engine";
  if (
    resourceType.includes("db_instance") ||
    resourceType.includes("sql_database") ||
    resourceType.includes("postgresql") ||
    resourceType.includes("mysql") ||
    resourceType.includes("mssql")
  )
    return "database";
  if (
    resourceType.includes("s3") ||
    resourceType.includes("storage_account") ||
    resourceType.includes("storage_bucket")
  )
    return "storage";
  return "general";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Analyse infrastructure costs and flag anomalies — resources whose estimated
 * costs are unusual compared to configured thresholds or heuristic baselines.
 */
export async function detectAnomalies(
  params: z.infer<typeof detectAnomaliesSchema>,
  pricingEngine: PricingEngine,
  cache: PricingCache,
  config: CloudCostConfig,
): Promise<AnomalyResult> {
  const inventory = await parseTerraform(params.files, params.tfvars);

  const targetProvider = params.provider as CloudProvider;
  const targetRegion =
    params.region ?? mapRegion(inventory.region, inventory.provider, targetProvider);

  const costEngine = new CostEngine(pricingEngine, config);
  const breakdown = await costEngine.calculateBreakdown(
    inventory.resources,
    targetProvider,
    targetRegion,
  );

  const totalMonthly = breakdown.total_monthly;
  const byResource = breakdown.by_resource;
  const anomalies: Anomaly[] = [];
  const recommendations: string[] = [];

  // -- a) Budget anomalies ------------------------------------------------

  if (params.budget_monthly != null && totalMonthly > params.budget_monthly) {
    anomalies.push({
      type: "budget_exceeded",
      severity: "high",
      resource: "_total",
      resource_type: "aggregate",
      message: `Total monthly cost $${totalMonthly.toFixed(2)} exceeds budget of $${params.budget_monthly.toFixed(2)}`,
      details: {
        current_cost: totalMonthly,
        threshold: params.budget_monthly,
      },
    });
    recommendations.push(
      `Total monthly cost exceeds budget by $${(totalMonthly - params.budget_monthly).toFixed(2)}. Consider right-sizing or removing unused resources.`,
    );
  }

  for (const est of byResource) {
    if (params.budget_per_resource != null && est.monthly_cost > params.budget_per_resource) {
      anomalies.push({
        type: "budget_exceeded",
        severity: "high",
        resource: est.resource_id,
        resource_type: est.resource_type,
        message: `Resource ${est.resource_id} costs $${est.monthly_cost.toFixed(2)}/mo, exceeding per-resource budget of $${params.budget_per_resource.toFixed(2)}`,
        details: {
          current_cost: est.monthly_cost,
          threshold: params.budget_per_resource,
        },
      });
    }
  }

  // -- b) Price change anomalies ------------------------------------------

  const priceChangeThreshold = params.price_change_threshold ?? 10;

  for (const est of byResource) {
    const service = serviceLabelForType(est.resource_type);
    const instanceType = resolveInstanceType(est);
    const resourceKey = instanceType ?? est.resource_type;

    const priceChange = cache.getPriceChange(targetProvider, service, resourceKey, targetRegion);

    if (priceChange && Math.abs(priceChange.change_percent) > priceChangeThreshold) {
      const direction = priceChange.change_percent > 0 ? "increased" : "decreased";
      anomalies.push({
        type: "price_change",
        severity: Math.abs(priceChange.change_percent) > 20 ? "high" : "medium",
        resource: est.resource_id,
        resource_type: est.resource_type,
        message: `Pricing for ${est.resource_id} has ${direction} by ${Math.abs(priceChange.change_percent).toFixed(1)}%`,
        details: {
          current_cost: est.monthly_cost,
          price_change_percent: priceChange.change_percent,
        },
      });
      recommendations.push(
        `Review pricing change for ${est.resource_id} (${Math.abs(priceChange.change_percent).toFixed(1)}% ${direction}). Consider locking in reserved pricing.`,
      );
    }
  }

  // -- c) Outlier detection (cost concentration) --------------------------

  if (totalMonthly > 0) {
    for (const est of byResource) {
      const sharePercent = (est.monthly_cost / totalMonthly) * 100;
      if (sharePercent > 50 && byResource.length > 1) {
        anomalies.push({
          type: "cost_concentration",
          severity: "medium",
          resource: est.resource_id,
          resource_type: est.resource_type,
          message: `Resource ${est.resource_id} accounts for ${sharePercent.toFixed(1)}% of total cost (concentration risk)`,
          details: {
            current_cost: est.monthly_cost,
            cost_share_percent: sharePercent,
          },
        });
        recommendations.push(
          `${est.resource_id} dominates total spend at ${sharePercent.toFixed(1)}%. Evaluate whether workload can be distributed or right-sized.`,
        );
      }
    }
  }

  // -- d) Right-sizing hints (oversized instances) ------------------------

  for (const est of byResource) {
    const instanceType = resolveInstanceType(est);
    if (isOversizedInstance(instanceType)) {
      anomalies.push({
        type: "potential_oversizing",
        severity: "low",
        resource: est.resource_id,
        resource_type: est.resource_type,
        message: `Instance ${est.resource_id} uses ${instanceType} which may be over-provisioned`,
        details: {
          current_cost: est.monthly_cost,
        },
      });
      recommendations.push(
        `Consider whether ${est.resource_id} (${instanceType}) needs all allocated resources. Smaller instance types can significantly reduce cost.`,
      );
    }
  }

  // -- Build summary ------------------------------------------------------

  const high = anomalies.filter((a) => a.severity === "high").length;
  const medium = anomalies.filter((a) => a.severity === "medium").length;
  const low = anomalies.filter((a) => a.severity === "low").length;

  return {
    total_monthly: totalMonthly,
    anomalies,
    summary: {
      total_resources: byResource.length,
      anomaly_count: anomalies.length,
      high_severity: high,
      medium_severity: medium,
      low_severity: low,
    },
    recommendations: [...new Set(recommendations)],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the instance/machine type from a CostEstimate. The breakdown notes
 * or resource_type itself may carry this information.
 */
function resolveInstanceType(est: CostEstimate): string | undefined {
  // Check breakdown line items for an instance type reference
  for (const item of est.breakdown) {
    // Descriptions often contain "t3.xlarge", "Standard_D4s_v3", etc.
    const match = item.description.match(
      /\b(t[23]\.\w+|m[5-7]\.\w+|c[5-7]\.\w+|r[5-7]\.\w+|Standard_\w+|n[12]d?-\w+-\d+|c2-\w+-\d+|e2-\w+-\d+)\b/i,
    );
    if (match) return match[1];
  }
  return undefined;
}
