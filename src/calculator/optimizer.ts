import type { ParsedResource } from "../types/resources.js";
import type { CostEstimate } from "../types/pricing.js";
import type { OptimizationRecommendation } from "../types/reports.js";
import { calculateReservedPricing } from "./reserved.js";

// ---------------------------------------------------------------------------
// Instance size heuristics
// ---------------------------------------------------------------------------

// Instance type size suffixes that are considered "xlarge or bigger".
// Used to identify potentially over-provisioned instances.
const LARGE_INSTANCE_SUFFIXES = [
  ".xlarge",
  ".2xlarge",
  ".4xlarge",
  ".8xlarge",
  ".16xlarge",
  "Standard_B4ms",
  "Standard_B8ms",
  "Standard_D4",
  "Standard_D8",
  "Standard_D16",
  "Standard_E4",
  "Standard_E8",
  "n2-standard-4",
  "n2-standard-8",
  "n2-standard-16",
  "e2-standard-4",
  "e2-standard-8",
];

// Tags / attribute indicators that suggest the instance is genuinely busy and
// right-sizing would be inappropriate.
const HIGH_UTILISATION_INDICATORS = [
  "high-cpu",
  "high-memory",
  "production",
  "prod",
  "perf",
  "performance",
];

function isLikelyOversized(resource: ParsedResource): boolean {
  const instanceType =
    (resource.attributes.instance_type as string | undefined) ??
    (resource.attributes.vm_size as string | undefined) ??
    (resource.attributes.machine_type as string | undefined) ??
    "";

  const isLarge = LARGE_INSTANCE_SUFFIXES.some((suffix) =>
    instanceType.toLowerCase().includes(suffix.toLowerCase())
  );
  if (!isLarge) return false;

  // If tags suggest it is a high-utilisation workload, do not suggest
  // right-sizing.
  const tagValues = Object.values(resource.tags).map((v) => v.toLowerCase());
  const tagKeys = Object.keys(resource.tags).map((k) => k.toLowerCase());
  const allTagText = [...tagKeys, ...tagValues].join(" ");

  const hasHighUtilisationSignal = HIGH_UTILISATION_INDICATORS.some((signal) =>
    allTagText.includes(signal)
  );

  return !hasHighUtilisationSignal;
}

// ---------------------------------------------------------------------------
// Compute resource type identifiers
// ---------------------------------------------------------------------------

const COMPUTE_RESOURCE_TYPES = new Set([
  "aws_instance",
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "google_compute_instance",
  "aws_eks_cluster",
  "aws_eks_node_group",
  "azurerm_kubernetes_cluster",
  "google_container_cluster",
  "google_container_node_pool",
]);

const DATABASE_RESOURCE_TYPES = new Set([
  "aws_db_instance",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server",
  "google_sql_database_instance",
]);

const OBJECT_STORAGE_RESOURCE_TYPES = new Set([
  "aws_s3_bucket",
  "azurerm_storage_account",
  "google_storage_bucket",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates cost optimisation recommendations from a set of cost estimates
 * and their corresponding parsed resource definitions.
 *
 * Recommendation types produced:
 *  - right_size:       Instance appears over-provisioned
 *  - reserved:         Switching to reserved/committed pricing would save money
 *  - switch_provider:  Another provider is significantly cheaper (>20% savings)
 *  - storage_tier:     Object storage could use a cheaper tier
 */
export function generateOptimizations(
  estimates: CostEstimate[],
  resources: ParsedResource[]
): OptimizationRecommendation[] {
  const recommendations: OptimizationRecommendation[] = [];

  // Build a lookup from resource_id to ParsedResource for quick access.
  const resourceById = new Map<string, ParsedResource>(
    resources.map((r) => [r.id, r])
  );

  // Group estimates by resource_id so we can compare providers.
  const estimatesByResourceId = new Map<string, CostEstimate[]>();
  for (const estimate of estimates) {
    const existing = estimatesByResourceId.get(estimate.resource_id) ?? [];
    existing.push(estimate);
    estimatesByResourceId.set(estimate.resource_id, existing);
  }

  for (const [resourceId, resourceEstimates] of estimatesByResourceId) {
    const resource = resourceById.get(resourceId);
    if (!resourceEstimates.length) continue;

    // Use the first estimate as the "current" provider cost for recommendations.
    const current = resourceEstimates[0];

    // Right-sizing recommendation.
    if (resource && COMPUTE_RESOURCE_TYPES.has(resource.type)) {
      if (isLikelyOversized(resource) && current.monthly_cost > 0) {
        // Estimate savings at 30% (moving down one instance size tier).
        const estimatedSavings = current.monthly_cost * 0.30;
        recommendations.push({
          resource_id: resourceId,
          resource_name: current.resource_name,
          type: "right_size",
          description:
            `${resource.attributes.instance_type ?? resource.attributes.vm_size ?? "Instance"} ` +
            `appears over-provisioned. Consider downsizing to the next smaller instance type.`,
          current_monthly_cost: current.monthly_cost,
          estimated_monthly_cost: current.monthly_cost - estimatedSavings,
          monthly_savings: estimatedSavings,
          percentage_savings: 30,
          confidence: "medium",
          provider: current.provider,
        });
      }
    }

    // Reserved instance recommendation for compute and DB resources.
    if (
      resource &&
      (COMPUTE_RESOURCE_TYPES.has(resource.type) ||
        DATABASE_RESOURCE_TYPES.has(resource.type)) &&
      current.monthly_cost > 0
    ) {
      const reserved = calculateReservedPricing(
        current.monthly_cost,
        current.provider
      );
      const best = reserved.best_option;

      if (best.percentage_savings >= 20) {
        recommendations.push({
          resource_id: resourceId,
          resource_name: current.resource_name,
          type: "reserved",
          description:
            `Switching to a ${best.term} ${best.payment.replace(/_/g, " ")} commitment ` +
            `could save approximately ${best.percentage_savings}% per month.`,
          current_monthly_cost: current.monthly_cost,
          estimated_monthly_cost: best.monthly_cost,
          monthly_savings: best.monthly_savings,
          percentage_savings: best.percentage_savings,
          confidence: "high",
          provider: current.provider,
        });
      }
    }

    // Switch provider recommendation (compare all provider estimates for the resource).
    if (resourceEstimates.length > 1 && current.monthly_cost > 0) {
      const cheapest = resourceEstimates.reduce(
        (min, e) => (e.monthly_cost < min.monthly_cost ? e : min),
        current
      );

      if (cheapest.provider !== current.provider) {
        const savings = current.monthly_cost - cheapest.monthly_cost;
        const pct = (savings / current.monthly_cost) * 100;

        if (pct >= 20) {
          recommendations.push({
            resource_id: resourceId,
            resource_name: current.resource_name,
            type: "switch_provider",
            description:
              `${cheapest.provider.toUpperCase()} offers this resource at $${cheapest.monthly_cost.toFixed(2)}/month ` +
              `vs $${current.monthly_cost.toFixed(2)}/month on ${current.provider.toUpperCase()}, ` +
              `saving approximately ${pct.toFixed(0)}%.`,
            current_monthly_cost: current.monthly_cost,
            estimated_monthly_cost: cheapest.monthly_cost,
            monthly_savings: savings,
            percentage_savings: Math.round(pct * 10) / 10,
            confidence: "medium",
            provider: cheapest.provider,
          });
        }
      }
    }

    // Object storage tier recommendation.
    if (resource && OBJECT_STORAGE_RESOURCE_TYPES.has(resource.type)) {
      const storageClass =
        (resource.attributes.storage_class as string | undefined) ?? "";
      const isHotTier =
        storageClass === "" ||
        storageClass.toLowerCase() === "standard" ||
        storageClass.toLowerCase() === "hot";

      if (isHotTier && current.monthly_cost > 0) {
        const estimatedSavings = current.monthly_cost * 0.40;
        recommendations.push({
          resource_id: resourceId,
          resource_name: current.resource_name,
          type: "storage_tier",
          description:
            "Consider using an infrequent-access or cool storage tier if data is not accessed daily. " +
            "This can reduce storage costs by ~40–60%.",
          current_monthly_cost: current.monthly_cost,
          estimated_monthly_cost: current.monthly_cost - estimatedSavings,
          monthly_savings: estimatedSavings,
          percentage_savings: 40,
          confidence: "low",
          provider: current.provider,
        });
      }
    }
  }

  return recommendations;
}
