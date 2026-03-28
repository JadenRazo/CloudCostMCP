import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default usage assumptions
// ---------------------------------------------------------------------------

const DEFAULT_INSTANCE_TYPE = "t3.medium.search";
const DEFAULT_INSTANCE_COUNT = 1;
const DEFAULT_VOLUME_SIZE_GB = 10;

// ---------------------------------------------------------------------------
// AWS OpenSearch instance pricing (on-demand, us-east-1, 2024)
// Per-hour rates for common instance types.
// ---------------------------------------------------------------------------

const AWS_OPENSEARCH_HOURLY_RATES: Record<string, number> = {
  "t3.small.search": 0.036,
  "t3.medium.search": 0.073,
  "m5.large.search": 0.142,
  "m5.xlarge.search": 0.284,
  "m5.2xlarge.search": 0.568,
  "m5.4xlarge.search": 1.136,
  "m6g.large.search": 0.128,
  "m6g.xlarge.search": 0.256,
  "r5.large.search": 0.186,
  "r5.xlarge.search": 0.372,
  "r6g.large.search": 0.167,
  "r6g.xlarge.search": 0.335,
  "c5.large.search": 0.122,
  "c5.xlarge.search": 0.244,
};

// Fallback rate when instance type is not in the table
const AWS_OPENSEARCH_DEFAULT_HOURLY = 0.073; // t3.medium.search equivalent

// EBS GP3 storage: $0.122/GB-month for OpenSearch
const AWS_OPENSEARCH_EBS_GP3_PER_GB = 0.122;

// GP2 storage: $0.135/GB-month
const AWS_OPENSEARCH_EBS_GP2_PER_GB = 0.135;

const MONTHLY_HOURS = 730;

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for an OpenSearch/Elasticsearch domain.
 *
 * Cost = instance_count * hourly_rate * 730h + volume_size_gb * storage_rate
 *
 * Uses bundled fallback pricing for common AWS OpenSearch instance types.
 */
export function calculateSearchCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const instanceType =
    (resource.attributes.instance_type as string | undefined) ?? DEFAULT_INSTANCE_TYPE;
  const instanceCount =
    (resource.attributes.instance_count as number | undefined) ?? DEFAULT_INSTANCE_COUNT;
  const volumeSizeGb =
    (resource.attributes.volume_size as number | undefined) ??
    (resource.attributes.storage_size_gb as number | undefined) ??
    DEFAULT_VOLUME_SIZE_GB;
  const engineVersion = resource.attributes.engine_version as string | undefined;

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    // Instance cost
    const hourlyRate = AWS_OPENSEARCH_HOURLY_RATES[instanceType] ?? AWS_OPENSEARCH_DEFAULT_HOURLY;
    const usedFallbackRate = !(instanceType in AWS_OPENSEARCH_HOURLY_RATES);

    if (usedFallbackRate) {
      notes.push(
        `Instance type "${instanceType}" not in bundled pricing table; using t3.medium.search rate as fallback`,
      );
    }

    const instanceMonthlyCost = instanceCount * hourlyRate * MONTHLY_HOURS;
    breakdown.push({
      description: `OpenSearch ${instanceType} (${instanceCount} instance${instanceCount !== 1 ? "s" : ""} x ${MONTHLY_HOURS}h/month)`,
      unit: "Hrs",
      quantity: instanceCount * MONTHLY_HOURS,
      unit_price: hourlyRate,
      monthly_cost: instanceMonthlyCost,
    });
    totalMonthly += instanceMonthlyCost;

    // EBS storage cost
    if (volumeSizeGb > 0) {
      const storageType = (resource.attributes.volume_type as string | undefined) ?? "gp3";
      const storageRate =
        storageType === "gp2" ? AWS_OPENSEARCH_EBS_GP2_PER_GB : AWS_OPENSEARCH_EBS_GP3_PER_GB;

      const storageCost = volumeSizeGb * instanceCount * storageRate;
      breakdown.push({
        description: `OpenSearch EBS ${storageType} storage (${volumeSizeGb} GB x ${instanceCount} instance${instanceCount !== 1 ? "s" : ""})`,
        unit: "GB-Mo",
        quantity: volumeSizeGb * instanceCount,
        unit_price: storageRate,
        monthly_cost: storageCost,
      });
      totalMonthly += storageCost;
    }

    if (engineVersion) {
      notes.push(`Engine version: ${engineVersion}`);
    }
  } else if (targetProvider === "azure") {
    // Azure Cognitive Search / Azure AI Search equivalent
    // Basic tier: ~$75.14/month, Standard S1: ~$250.46/month
    const azureTierMonthly = 250.46; // Standard S1 as default
    breakdown.push({
      description: "Azure AI Search Standard S1",
      unit: "Mo",
      quantity: 1,
      unit_price: azureTierMonthly,
      monthly_cost: azureTierMonthly,
    });
    totalMonthly = azureTierMonthly;
    notes.push(
      "Azure equivalent: Azure AI Search Standard S1 tier (approximate cross-provider mapping)",
    );
  } else {
    // GCP does not have a direct managed OpenSearch equivalent.
    // Estimate based on a comparable GKE-hosted Elasticsearch.
    const gcpEquivalentMonthly = 200.0;
    breakdown.push({
      description: "Estimated OpenSearch-equivalent on GCP",
      unit: "Mo",
      quantity: 1,
      unit_price: gcpEquivalentMonthly,
      monthly_cost: gcpEquivalentMonthly,
    });
    totalMonthly = gcpEquivalentMonthly;
    notes.push(
      "GCP has no direct managed OpenSearch service; estimate based on comparable compute cost",
    );
  }

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: targetProvider === "aws" ? "medium" : "low",
    notes,
    pricing_source: "fallback",
  };
}
