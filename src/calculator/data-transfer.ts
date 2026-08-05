import type { CloudProvider, ParsedResource } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import { regionMultiplier } from "../pricing/region-multiplier.js";
import { makeCostEstimate } from "./estimate-factory.js";

// Default egress volume (GB/month) for data transfer cost estimates when no
// explicit traffic figure is available in the resource attributes.
export const DEFAULT_EGRESS_GB = 100;

// ---------------------------------------------------------------------------
// Per-provider internet egress pricing (baseline US/EU region rates).
//   AWS:   Data Transfer pricing, us-east-1 baseline — first 10 TB/month
//          beyond the free tier is $0.09/GB.
//   Azure: Bandwidth pricing, Zone 1 (North America + Europe) — $0.087/GB.
//   GCP:   Network pricing (region -> internet) — $0.085/GB for the first
//          TB/month in most regions.
// Regional variation is applied via data/region-price-multipliers.json (the
// shared multiplier table also used for fallback pricing).
// ---------------------------------------------------------------------------

interface EgressPricing {
  /** Baseline internet-egress rate in USD per GB. */
  ratePerGb: number;
  /** Provider-specific scope disclaimer appended to the estimate notes. */
  note: string;
}

const EGRESS_PRICING: Record<CloudProvider, EgressPricing> = {
  aws: {
    ratePerGb: 0.09,
    note:
      "Data transfer costs cover internet egress only; intra-region and inter-AZ " +
      "traffic charges are excluded from this estimate",
  },
  azure: {
    ratePerGb: 0.087,
    note:
      "Data transfer costs cover internet egress only; intra-region traffic " +
      "is free on Azure and excluded from this estimate",
  },
  gcp: {
    ratePerGb: 0.085,
    note:
      "Data transfer costs cover internet egress only; intra-region and " +
      "Google network traffic charges are excluded from this estimate",
  },
};

/**
 * Calculates estimated monthly data transfer (egress) cost for a resource on
 * the given provider.
 *
 * Uses the provider's baseline internet-egress rate adjusted by the shared
 * regional price multiplier table. The egress volume defaults to
 * DEFAULT_EGRESS_GB when not specified via the monthly_egress_gb attribute on
 * the synthetic resource.
 */
export function calculateEgressCost(
  resource: ParsedResource,
  provider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const egressGb =
    (resource.attributes.monthly_egress_gb as number | undefined) ?? DEFAULT_EGRESS_GB;

  if (
    !resource.attributes.monthly_egress_gb ||
    (resource.attributes.monthly_egress_gb as number) <= 0
  ) {
    notes.push(
      `Data transfer cost estimated at ${egressGb} GB/month egress; ` +
        `actual costs depend on traffic volume and destination`,
    );
  }

  const pricing = EGRESS_PRICING[provider];
  const ratePerGb = pricing.ratePerGb * regionMultiplier(provider, targetRegion);
  const totalMonthly = ratePerGb * egressGb;

  breakdown.push({
    description: `Internet egress (${egressGb} GB/month, estimated)`,
    unit: "GB",
    quantity: egressGb,
    unit_price: ratePerGb,
    monthly_cost: totalMonthly,
  });

  notes.push(pricing.note);

  return makeCostEstimate({
    resource,
    provider,
    region: targetRegion,
    monthlyCost: totalMonthly,
    breakdown,
    confidence: "low",
    notes,
    pricingSource: "fallback",
  });
}

// ---------------------------------------------------------------------------
// Backwards-compatible per-provider wrappers.
// ---------------------------------------------------------------------------

/** Calculates estimated monthly data transfer (egress) cost for AWS resources. */
export function calculateAwsDataTransferCost(
  resource: ParsedResource,
  targetRegion: string,
): CostEstimate {
  return calculateEgressCost(resource, "aws", targetRegion);
}

/** Calculates estimated monthly data transfer (egress) cost for Azure resources. */
export function calculateAzureDataTransferCost(
  resource: ParsedResource,
  targetRegion: string,
): CostEstimate {
  return calculateEgressCost(resource, "azure", targetRegion);
}

/** Calculates estimated monthly data transfer (egress) cost for GCP resources. */
export function calculateGcpDataTransferCost(
  resource: ParsedResource,
  targetRegion: string,
): CostEstimate {
  return calculateEgressCost(resource, "gcp", targetRegion);
}
