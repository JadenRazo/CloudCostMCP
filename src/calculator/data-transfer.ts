import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default monthly transfer volumes
// ---------------------------------------------------------------------------

const DEFAULT_EGRESS_GB = 100;
const DEFAULT_CROSS_REGION_GB = 50;

// ---------------------------------------------------------------------------
// AWS data transfer pricing (us-east-1 reference rates, 2024)
// ---------------------------------------------------------------------------

// Internet egress tiers
const AWS_EGRESS_FIRST_1GB = 0.0; // First 1 GB/month free
const AWS_EGRESS_NEXT_9999GB = 0.09; // $0.09/GB for next ~10TB
const AWS_EGRESS_NEXT_40TB = 0.085; // $0.085/GB for next 40TB

// Cross-AZ data transfer
const AWS_CROSS_AZ_PER_GB = 0.01;

// NAT Gateway data processing
const AWS_NAT_DATA_PROCESSING_PER_GB = 0.045;

/**
 * Calculates AWS internet egress cost using tiered pricing.
 */
function awsEgressCost(totalGb: number): number {
  if (totalGb <= 1) return 0;

  let cost = 0;
  let remaining = totalGb - 1; // first 1 GB free

  const tier1 = Math.min(remaining, 9999);
  cost += tier1 * AWS_EGRESS_NEXT_9999GB;
  remaining -= tier1;

  if (remaining > 0) {
    const tier2 = Math.min(remaining, 40 * 1024);
    cost += tier2 * AWS_EGRESS_NEXT_40TB;
    remaining -= tier2;

    if (remaining > 0) {
      // Beyond 50TB: $0.07/GB (approximate)
      cost += remaining * 0.07;
    }
  }

  return cost;
}

/**
 * Calculates the monthly data transfer cost for an AWS NAT Gateway resource.
 * Supplements the existing NAT gateway hourly cost in network.ts.
 */
export function calculateAwsDataTransferCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;
  const crossRegionGb =
    (resource.attributes.monthly_cross_region_gb as number | undefined) ??
    DEFAULT_CROSS_REGION_GB;
  const crossAzGb =
    (resource.attributes.monthly_cross_az_gb as number | undefined) ?? 0;

  let totalMonthly = 0;

  // Internet egress (tiered)
  const egressCost = awsEgressCost(egressGb);
  if (egressCost > 0) {
    // Use effective average rate for display
    const avgRate = egressCost / Math.max(egressGb, 1);
    breakdown.push({
      description: `AWS internet egress (${egressGb}GB/month)`,
      unit: "GB",
      quantity: egressGb,
      unit_price: avgRate,
      monthly_cost: egressCost,
    });
    totalMonthly += egressCost;
  }

  // Cross-region transfer
  if (crossRegionGb > 0) {
    const crossRegionCost = crossRegionGb * 0.02;
    breakdown.push({
      description: `AWS cross-region data transfer (${crossRegionGb}GB/month)`,
      unit: "GB",
      quantity: crossRegionGb,
      unit_price: 0.02,
      monthly_cost: crossRegionCost,
    });
    totalMonthly += crossRegionCost;
  }

  // Cross-AZ transfer
  if (crossAzGb > 0) {
    const crossAzCost = crossAzGb * AWS_CROSS_AZ_PER_GB;
    breakdown.push({
      description: `AWS cross-AZ data transfer (${crossAzGb}GB/month)`,
      unit: "GB",
      quantity: crossAzGb,
      unit_price: AWS_CROSS_AZ_PER_GB,
      monthly_cost: crossAzCost,
    });
    totalMonthly += crossAzCost;
  }

  if (!resource.attributes.monthly_egress_gb) {
    notes.push(
      `Default egress assumption: ${DEFAULT_EGRESS_GB}GB/month internet + ${DEFAULT_CROSS_REGION_GB}GB cross-region — ` +
      "provide monthly_egress_gb and monthly_cross_region_gb for accuracy"
    );
  }

  notes.push(
    "AWS internet egress: first 1GB free, then $0.09/GB (first ~10TB), $0.085/GB (next 40TB)"
  );

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
    confidence: "medium",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// Azure data transfer pricing
// ---------------------------------------------------------------------------

const AZURE_EGRESS_NEXT_9995GB = 0.087;
const AZURE_CROSS_REGION_PER_GB = 0.02;

/**
 * Calculates Azure internet egress cost with 5GB free tier.
 */
function azureEgressCost(totalGb: number): number {
  if (totalGb <= 5) return 0;

  let cost = 0;
  let remaining = totalGb - 5; // first 5 GB free

  const tier1 = Math.min(remaining, 9995);
  cost += tier1 * AZURE_EGRESS_NEXT_9995GB;
  remaining -= tier1;

  if (remaining > 0) {
    // Beyond ~10TB: $0.083/GB approximate
    cost += remaining * 0.083;
  }

  return cost;
}

/**
 * Calculates the monthly data transfer cost for an Azure resource.
 */
export function calculateAzureDataTransferCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;
  const crossRegionGb =
    (resource.attributes.monthly_cross_region_gb as number | undefined) ??
    DEFAULT_CROSS_REGION_GB;

  let totalMonthly = 0;

  // Internet egress
  const egressCost = azureEgressCost(egressGb);
  if (egressCost > 0) {
    const avgRate = egressCost / Math.max(egressGb, 1);
    breakdown.push({
      description: `Azure internet egress (${egressGb}GB/month)`,
      unit: "GB",
      quantity: egressGb,
      unit_price: avgRate,
      monthly_cost: egressCost,
    });
    totalMonthly += egressCost;
  }

  // Cross-region
  if (crossRegionGb > 0) {
    const crossRegionCost = crossRegionGb * AZURE_CROSS_REGION_PER_GB;
    breakdown.push({
      description: `Azure cross-region data transfer (${crossRegionGb}GB/month)`,
      unit: "GB",
      quantity: crossRegionGb,
      unit_price: AZURE_CROSS_REGION_PER_GB,
      monthly_cost: crossRegionCost,
    });
    totalMonthly += crossRegionCost;
  }

  if (!resource.attributes.monthly_egress_gb) {
    notes.push(
      `Default egress assumption: ${DEFAULT_EGRESS_GB}GB/month internet + ${DEFAULT_CROSS_REGION_GB}GB cross-region`
    );
  }

  notes.push("Azure internet egress: first 5GB free, then $0.087/GB (first ~10TB)");

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
    confidence: "medium",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// GCP data transfer pricing
// ---------------------------------------------------------------------------

const GCP_EGRESS_PREMIUM_PER_GB = 0.12;
const GCP_EGRESS_STANDARD_PER_GB = 0.085;
const GCP_CROSS_REGION_PER_GB = 0.01;

/**
 * Calculates the monthly data transfer cost for a GCP resource.
 *
 * Premium tier: $0.12/GB, Standard tier: $0.085/GB
 */
export function calculateGcpDataTransferCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;
  const crossRegionGb =
    (resource.attributes.monthly_cross_region_gb as number | undefined) ??
    DEFAULT_CROSS_REGION_GB;
  const tier =
    ((resource.attributes.network_tier as string | undefined) ?? "PREMIUM").toUpperCase();

  const egressRate = tier === "STANDARD" ? GCP_EGRESS_STANDARD_PER_GB : GCP_EGRESS_PREMIUM_PER_GB;

  let totalMonthly = 0;

  const egressCost = egressGb * egressRate;
  breakdown.push({
    description: `GCP internet egress ${tier} tier (${egressGb}GB/month)`,
    unit: "GB",
    quantity: egressGb,
    unit_price: egressRate,
    monthly_cost: egressCost,
  });
  totalMonthly += egressCost;

  if (crossRegionGb > 0) {
    const crossRegionCost = crossRegionGb * GCP_CROSS_REGION_PER_GB;
    breakdown.push({
      description: `GCP cross-region data transfer (${crossRegionGb}GB/month)`,
      unit: "GB",
      quantity: crossRegionGb,
      unit_price: GCP_CROSS_REGION_PER_GB,
      monthly_cost: crossRegionCost,
    });
    totalMonthly += crossRegionCost;
  }

  if (!resource.attributes.monthly_egress_gb) {
    notes.push(
      `Default egress assumption: ${DEFAULT_EGRESS_GB}GB/month internet + ${DEFAULT_CROSS_REGION_GB}GB cross-region`
    );
  }

  notes.push(`GCP ${tier} tier network egress at $${egressRate}/GB`);

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
    confidence: "medium",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// NAT Gateway data processing supplement
// ---------------------------------------------------------------------------

/**
 * Calculates the data processing cost component for a NAT Gateway.
 * This supplements the hourly charge already calculated in network.ts.
 */
export function calculateNatDataProcessingCost(
  dataGb: number,
  provider: CloudProvider,
  _region: string
): number {
  switch (provider) {
    case "aws":
      return dataGb * AWS_NAT_DATA_PROCESSING_PER_GB;
    case "azure":
      // Azure NAT Gateway: $0.045/GB processed
      return dataGb * 0.045;
    case "gcp":
      // GCP Cloud NAT: $0.045/GB processed
      return dataGb * 0.045;
    default:
      return 0;
  }
}
