import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

const MONTHLY_HOURS = 730;

// ---------------------------------------------------------------------------
// AWS SageMaker endpoint pricing (approximate us-east-1 on-demand, 2024)
// ---------------------------------------------------------------------------

const SAGEMAKER_INSTANCE_PRICES: Record<string, number> = {
  // ml.t3.* (burstable)
  "ml.t3.medium": 0.05,
  "ml.t3.large": 0.1,
  "ml.t3.xlarge": 0.2,
  "ml.t3.2xlarge": 0.4,
  // ml.m5.* (general purpose)
  "ml.m5.large": 0.115,
  "ml.m5.xlarge": 0.23,
  "ml.m5.2xlarge": 0.461,
  "ml.m5.4xlarge": 0.922,
  "ml.m5.12xlarge": 2.765,
  "ml.m5.24xlarge": 5.53,
  // ml.c5.* (compute optimized)
  "ml.c5.large": 0.102,
  "ml.c5.xlarge": 0.204,
  "ml.c5.2xlarge": 0.408,
  "ml.c5.4xlarge": 0.816,
  "ml.c5.9xlarge": 1.836,
  // ml.p3.* (GPU)
  "ml.p3.2xlarge": 3.825,
  "ml.p3.8xlarge": 14.688,
  "ml.p3.16xlarge": 28.152,
  // ml.g4dn.* (GPU, inference-optimized)
  "ml.g4dn.xlarge": 0.736,
  "ml.g4dn.2xlarge": 0.94,
  "ml.g4dn.4xlarge": 1.505,
  "ml.g4dn.8xlarge": 2.72,
  "ml.g4dn.12xlarge": 4.89,
  // ml.g5.* (GPU, newer)
  "ml.g5.xlarge": 1.006,
  "ml.g5.2xlarge": 1.515,
  "ml.g5.4xlarge": 2.03,
  "ml.g5.12xlarge": 7.09,
  // ml.inf1.* (Inferentia)
  "ml.inf1.xlarge": 0.297,
  "ml.inf1.2xlarge": 0.471,
  "ml.inf1.6xlarge": 1.21,
  "ml.inf1.24xlarge": 4.841,
};

// ---------------------------------------------------------------------------
// GCP Vertex AI endpoint pricing (approximate, 2024)
// ---------------------------------------------------------------------------

const VERTEX_AI_MACHINE_PRICES: Record<string, number> = {
  // n1-standard series
  "n1-standard-2": 0.095,
  "n1-standard-4": 0.19,
  "n1-standard-8": 0.38,
  "n1-standard-16": 0.76,
  "n1-standard-32": 1.52,
  // e2-standard series
  "e2-standard-2": 0.067,
  "e2-standard-4": 0.134,
  "e2-standard-8": 0.268,
  "e2-standard-16": 0.536,
  // GPU-enabled (approximate, includes GPU cost)
  "n1-standard-4-nvidia-tesla-t4": 0.545,
  "n1-standard-8-nvidia-tesla-t4": 0.735,
  "n1-standard-8-nvidia-tesla-v100": 2.88,
  "n1-standard-16-nvidia-tesla-v100": 3.07,
};

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for an ML/AI inference endpoint.
 *
 * AWS SageMaker: pricing by ml.* instance type
 * GCP Vertex AI: pricing by machine type
 *
 * ML/AI pricing is highly variable — confidence is always "low" for fallback
 * estimates since actual costs depend on auto-scaling, spot/preemptible usage,
 * and real-time inference patterns.
 */
export function calculateMlAiCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    const instanceType = (resource.attributes.instance_type as string | undefined) ?? "ml.m5.large";
    const instanceCount = (resource.attributes.instance_count as number | undefined) ?? 1;

    const hourlyPrice = SAGEMAKER_INSTANCE_PRICES[instanceType.toLowerCase()];

    if (hourlyPrice !== undefined) {
      const perInstanceMonthly = hourlyPrice * MONTHLY_HOURS;
      totalMonthly = perInstanceMonthly * instanceCount;

      breakdown.push({
        description: `SageMaker endpoint ${instanceType} x${instanceCount} (${MONTHLY_HOURS}h/month)`,
        unit: "Hrs",
        quantity: instanceCount * MONTHLY_HOURS,
        unit_price: hourlyPrice,
        monthly_cost: totalMonthly,
      });

      notes.push(`SageMaker endpoint: ${instanceCount} x ${instanceType}`);
    } else {
      notes.push(
        `No pricing data found for SageMaker instance type ${instanceType}; cost reported as $0`,
      );
    }

    notes.push(
      "ML/AI endpoint pricing is highly variable — actual costs depend on auto-scaling and traffic patterns",
    );
  } else if (targetProvider === "gcp") {
    const machineType = (resource.attributes.machine_type as string | undefined) ?? "n1-standard-4";
    const instanceCount = (resource.attributes.instance_count as number | undefined) ?? 1;

    const hourlyPrice = VERTEX_AI_MACHINE_PRICES[machineType.toLowerCase()];

    if (hourlyPrice !== undefined) {
      const perInstanceMonthly = hourlyPrice * MONTHLY_HOURS;
      totalMonthly = perInstanceMonthly * instanceCount;

      breakdown.push({
        description: `Vertex AI endpoint ${machineType} x${instanceCount} (${MONTHLY_HOURS}h/month)`,
        unit: "Hrs",
        quantity: instanceCount * MONTHLY_HOURS,
        unit_price: hourlyPrice,
        monthly_cost: totalMonthly,
      });

      notes.push(`Vertex AI endpoint: ${instanceCount} x ${machineType}`);
    } else {
      notes.push(
        `No pricing data found for Vertex AI machine type ${machineType}; cost reported as $0`,
      );
    }

    notes.push(
      "ML/AI endpoint pricing is highly variable — actual costs depend on auto-scaling and traffic patterns",
    );
  } else {
    // Azure — no direct equivalent handled yet; report zero with a note
    notes.push(
      "Azure ML endpoint pricing not yet supported — consider Azure Machine Learning compute instance costs",
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
    confidence: "low",
    notes,
    pricing_source: "fallback",
  };
}
