import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// Default egress volume (GB/month) for data transfer cost estimates when no
// explicit traffic figure is available in the resource attributes.
const DEFAULT_EGRESS_GB = 100;

// ---------------------------------------------------------------------------
// AWS data transfer pricing
// Rates based on AWS Data Transfer pricing (us-east-1 baseline, 2024).
// Internet egress: first 10 TB/month is $0.09/GB (beyond free tier).
// ---------------------------------------------------------------------------
const AWS_EGRESS_PER_GB = 0.09;

// ---------------------------------------------------------------------------
// Azure data transfer pricing
// Rates based on Azure Bandwidth pricing (Zone 1 / North America + Europe).
// Internet egress: first 10 TB/month is $0.087/GB.
// ---------------------------------------------------------------------------
const AZURE_EGRESS_PER_GB = 0.087;

// ---------------------------------------------------------------------------
// GCP data transfer pricing
// Rates based on GCP Network pricing (from Google Cloud regions to internet).
// Internet egress: $0.085/GB for first TB/month (most regions).
// ---------------------------------------------------------------------------
const GCP_EGRESS_PER_GB = 0.085;

// ---------------------------------------------------------------------------
// Regional multipliers for data transfer costs.
// Some regions (APAC, South America) have notably higher egress rates.
// ---------------------------------------------------------------------------

const AWS_REGION_MULTIPLIERS: Record<string, number> = {
  "us-east-1": 1.0,
  "us-east-2": 1.0,
  "us-west-1": 1.0,
  "us-west-2": 1.0,
  "eu-west-1": 1.0,
  "eu-west-2": 1.0,
  "eu-central-1": 1.0,
  "ap-southeast-1": 1.11, // $0.10/GB
  "ap-southeast-2": 1.11,
  "ap-northeast-1": 1.11,
  "ap-northeast-2": 1.11,
  "ap-south-1": 1.11,
  "sa-east-1": 1.31, // $0.118/GB
  "ca-central-1": 1.0,
  "eu-north-1": 1.0,
  "me-south-1": 1.11,
  "af-south-1": 1.16, // $0.1046/GB
};

const AZURE_REGION_MULTIPLIERS: Record<string, number> = {
  "eastus": 1.0,
  "eastus2": 1.0,
  "westus": 1.0,
  "westus2": 1.0,
  "westus3": 1.0,
  "centralus": 1.0,
  "northeurope": 1.0,
  "westeurope": 1.0,
  "uksouth": 1.0,
  "ukwest": 1.0,
  "germanywestcentral": 1.0,
  "francecentral": 1.0,
  "eastasia": 1.16, // Zone 2 rate
  "southeastasia": 1.16,
  "japaneast": 1.16,
  "koreacentral": 1.16,
  "australiaeast": 1.24, // Zone 3 rate
  "brazilsouth": 1.31,
  "southafricanorth": 1.31,
};

const GCP_REGION_MULTIPLIERS: Record<string, number> = {
  "us-central1": 1.0,
  "us-east1": 1.0,
  "us-east4": 1.0,
  "us-west1": 1.0,
  "us-west2": 1.0,
  "us-west3": 1.0,
  "us-west4": 1.0,
  "europe-west1": 1.0,
  "europe-west2": 1.0,
  "europe-west3": 1.0,
  "europe-west4": 1.0,
  "europe-west6": 1.0,
  "europe-north1": 1.0,
  "northamerica-northeast1": 1.0,
  "southamerica-east1": 1.59, // $0.135/GB
  "asia-east1": 1.41, // $0.12/GB (APAC)
  "asia-east2": 1.41,
  "asia-northeast1": 1.41,
  "asia-northeast2": 1.41,
  "asia-northeast3": 1.41,
  "asia-south1": 1.41,
  "asia-southeast1": 1.41,
  "asia-southeast2": 1.41,
  "australia-southeast1": 1.41,
  "australia-southeast2": 1.41,
};

function awsRegionMultiplier(region: string): number {
  return AWS_REGION_MULTIPLIERS[region.toLowerCase()] ?? 1.0;
}

function azureRegionMultiplier(region: string): number {
  return AZURE_REGION_MULTIPLIERS[region.toLowerCase()] ?? 1.0;
}

function gcpRegionMultiplier(region: string): number {
  return GCP_REGION_MULTIPLIERS[region.toLowerCase()] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Per-provider data transfer cost calculators
// ---------------------------------------------------------------------------

/**
 * Calculates estimated monthly data transfer (egress) cost for AWS resources.
 *
 * Uses the standard AWS internet egress rate for the given region.
 * The egress volume defaults to DEFAULT_EGRESS_GB when not specified via
 * the monthly_egress_gb attribute on the synthetic resource.
 */
export async function calculateAwsDataTransferCost(
  resource: ParsedResource,
  targetRegion: string
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;

  if (
    !resource.attributes.monthly_egress_gb ||
    (resource.attributes.monthly_egress_gb as number) <= 0
  ) {
    notes.push(
      `Data transfer cost estimated at ${egressGb} GB/month egress; ` +
        `actual costs depend on traffic volume and destination`
    );
  }

  const multiplier = awsRegionMultiplier(targetRegion);
  const ratePerGb = AWS_EGRESS_PER_GB * multiplier;
  const totalMonthly = ratePerGb * egressGb;

  breakdown.push({
    description: `Internet egress (${egressGb} GB/month, estimated)`,
    unit: "GB",
    quantity: egressGb,
    unit_price: ratePerGb,
    monthly_cost: totalMonthly,
  });

  notes.push(
    "Data transfer costs cover internet egress only; intra-region and inter-AZ " +
      "traffic charges are excluded from this estimate"
  );

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: "aws",
    region: targetRegion,
    monthly_cost: Math.round(totalMonthly * 100) / 100,
    yearly_cost: Math.round(totalMonthly * 12 * 100) / 100,
    currency: "USD",
    breakdown,
    confidence: "low",
    notes,
    pricing_source: "fallback",
  };
}

/**
 * Calculates estimated monthly data transfer (egress) cost for Azure resources.
 *
 * Uses the Azure Bandwidth pricing for Zone 1 (North America / Europe) as the
 * baseline, with multipliers applied for higher-cost zones (APAC, Brazil, etc).
 */
export async function calculateAzureDataTransferCost(
  resource: ParsedResource,
  targetRegion: string
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;

  if (
    !resource.attributes.monthly_egress_gb ||
    (resource.attributes.monthly_egress_gb as number) <= 0
  ) {
    notes.push(
      `Data transfer cost estimated at ${egressGb} GB/month egress; ` +
        `actual costs depend on traffic volume and destination`
    );
  }

  const multiplier = azureRegionMultiplier(targetRegion);
  const ratePerGb = AZURE_EGRESS_PER_GB * multiplier;
  const totalMonthly = ratePerGb * egressGb;

  breakdown.push({
    description: `Internet egress (${egressGb} GB/month, estimated)`,
    unit: "GB",
    quantity: egressGb,
    unit_price: ratePerGb,
    monthly_cost: totalMonthly,
  });

  notes.push(
    "Data transfer costs cover internet egress only; intra-region traffic " +
      "is free on Azure and excluded from this estimate"
  );

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: "azure",
    region: targetRegion,
    monthly_cost: Math.round(totalMonthly * 100) / 100,
    yearly_cost: Math.round(totalMonthly * 12 * 100) / 100,
    currency: "USD",
    breakdown,
    confidence: "low",
    notes,
    pricing_source: "fallback",
  };
}

/**
 * Calculates estimated monthly data transfer (egress) cost for GCP resources.
 *
 * Uses Google Cloud's internet egress pricing, with higher multipliers for
 * APAC and South America regions that carry premium egress rates.
 */
export async function calculateGcpDataTransferCost(
  resource: ParsedResource,
  targetRegion: string
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ??
    DEFAULT_EGRESS_GB;

  if (
    !resource.attributes.monthly_egress_gb ||
    (resource.attributes.monthly_egress_gb as number) <= 0
  ) {
    notes.push(
      `Data transfer cost estimated at ${egressGb} GB/month egress; ` +
        `actual costs depend on traffic volume and destination`
    );
  }

  const multiplier = gcpRegionMultiplier(targetRegion);
  const ratePerGb = GCP_EGRESS_PER_GB * multiplier;
  const totalMonthly = ratePerGb * egressGb;

  breakdown.push({
    description: `Internet egress (${egressGb} GB/month, estimated)`,
    unit: "GB",
    quantity: egressGb,
    unit_price: ratePerGb,
    monthly_cost: totalMonthly,
  });

  notes.push(
    "Data transfer costs cover internet egress only; intra-region and " +
      "Google network traffic charges are excluded from this estimate"
  );

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: "gcp",
    region: targetRegion,
    monthly_cost: Math.round(totalMonthly * 100) / 100,
    yearly_cost: Math.round(totalMonthly * 12 * 100) / 100,
    currency: "USD",
    breakdown,
    confidence: "low",
    notes,
    pricing_source: "fallback",
  };
}
