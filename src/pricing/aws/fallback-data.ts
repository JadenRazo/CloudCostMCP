import { getRegionPriceMultipliers } from "../../data/loader.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Fallback pricing data (approximate us-east-1 on-demand prices, April 2026)
// Used when the live AWS Bulk Pricing API is unreachable.
// ---------------------------------------------------------------------------

export const EC2_BASE_PRICES: Record<string, number> = {
  "t2.micro": 0.0116,
  "t2.small": 0.023,
  "t2.medium": 0.0464,
  "t2.large": 0.0928,
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "t3.2xlarge": 0.3328,
  "t3a.micro": 0.0094,
  "t3a.small": 0.0188,
  "t3a.medium": 0.0376,
  "t3a.large": 0.0752,
  "t3a.xlarge": 0.1504,
  "t4g.micro": 0.0084,
  "t4g.small": 0.0168,
  "t4g.medium": 0.0336,
  "t4g.large": 0.0672,
  "t4g.xlarge": 0.1344,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m5.2xlarge": 0.384,
  "m5.4xlarge": 0.768,
  "m5a.large": 0.086,
  "m5a.xlarge": 0.172,
  "m5a.2xlarge": 0.344,
  "m5a.4xlarge": 0.688,
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "m6i.2xlarge": 0.384,
  "m6i.4xlarge": 0.768,
  "m6i.8xlarge": 1.536,
  "m6g.large": 0.077,
  "m6g.xlarge": 0.154,
  "m6g.2xlarge": 0.308,
  "m6g.4xlarge": 0.616,
  "m7i.large": 0.1008,
  "m7i.xlarge": 0.2016,
  "m7i.2xlarge": 0.4032,
  // m7i-flex: Intel 4th-gen "flex" variant, ~5% cheaper than m7i, us-east-1 Linux.
  "m7i-flex.large": 0.09576,
  "m7i-flex.xlarge": 0.19152,
  "m7i-flex.2xlarge": 0.38304,
  "m7i-flex.4xlarge": 0.76608,
  "m7i-flex.8xlarge": 1.53216,
  "m7g.large": 0.0816,
  "m7g.xlarge": 0.1632,
  "m7g.2xlarge": 0.3264,
  "m7g.4xlarge": 0.6528,
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
  "c5.2xlarge": 0.34,
  "c5a.large": 0.077,
  "c5a.xlarge": 0.154,
  "c5a.2xlarge": 0.308,
  "c6i.large": 0.085,
  "c6i.xlarge": 0.17,
  "c6i.2xlarge": 0.34,
  "c6g.large": 0.068,
  "c6g.xlarge": 0.136,
  "c6g.2xlarge": 0.272,
  "c6g.4xlarge": 0.544,
  "c7i.large": 0.089,
  "c7i.xlarge": 0.178,
  "c7i.2xlarge": 0.357,
  "c7g.large": 0.072,
  "c7g.xlarge": 0.145,
  "c7g.2xlarge": 0.29,
  "c7g.4xlarge": 0.58,
  "r5.large": 0.126,
  "r5.xlarge": 0.252,
  "r5.2xlarge": 0.504,
  "r5a.large": 0.113,
  "r5a.xlarge": 0.226,
  "r5a.2xlarge": 0.452,
  "r6i.large": 0.126,
  "r6i.xlarge": 0.252,
  "r6i.2xlarge": 0.504,
  "r6g.large": 0.101,
  "r6g.xlarge": 0.202,
  "r6g.2xlarge": 0.403,
  "r6g.4xlarge": 0.806,
  "r7i.large": 0.133,
  "r7i.xlarge": 0.266,
  "r7i.2xlarge": 0.532,
  "r7g.large": 0.107,
  "r7g.xlarge": 0.214,
  "r7g.2xlarge": 0.428,
  "r7g.4xlarge": 0.856,

  // 8th-gen Graviton4 families
  "m8g.large": 0.077,
  "m8g.xlarge": 0.154,
  "m8g.2xlarge": 0.308,
  "m8g.4xlarge": 0.616,
  "c8g.large": 0.068,
  "c8g.xlarge": 0.136,
  "c8g.2xlarge": 0.272,
  "c8g.4xlarge": 0.544,
  "r8g.large": 0.101,
  "r8g.xlarge": 0.202,
  "r8g.2xlarge": 0.404,
  "r8g.4xlarge": 0.808,

  // GPU instances
  "g5.xlarge": 1.006,
  "g5.2xlarge": 1.212,
  "g5.4xlarge": 1.624,
  "g5.8xlarge": 2.448,
  "g5.12xlarge": 5.672,
  "p4d.24xlarge": 32.7726,
};

export const RDS_BASE_PRICES: Record<string, number> = {
  "db.t3.micro": 0.017,
  "db.t3.small": 0.034,
  "db.t3.medium": 0.068,
  "db.t3.large": 0.136,
  "db.t4g.micro": 0.016,
  "db.t4g.small": 0.032,
  "db.t4g.medium": 0.065,
  "db.t4g.large": 0.129,
  "db.t4g.xlarge": 0.258,
  "db.m5.large": 0.171,
  "db.m5.xlarge": 0.342,
  "db.m6g.large": 0.154,
  "db.m6g.xlarge": 0.308,
  "db.m6g.2xlarge": 0.616,
  "db.m6i.large": 0.171,
  "db.m6i.xlarge": 0.342,
  "db.m6i.2xlarge": 0.684,
  "db.m7g.large": 0.168,
  "db.m7g.xlarge": 0.336,
  "db.m7g.2xlarge": 0.672,
  "db.r5.large": 0.25,
  "db.r5.xlarge": 0.5,
  "db.r5.2xlarge": 1.0,
  "db.r6g.large": 0.218,
  "db.r6g.xlarge": 0.437,
  "db.r6g.2xlarge": 0.874,
  "db.r6i.large": 0.25,
  "db.r6i.xlarge": 0.5,
  "db.r6i.2xlarge": 1.0,
};

export const EBS_BASE_PRICES: Record<string, number> = {
  gp3: 0.08,
  gp2: 0.1,
  io2: 0.125,
  io1: 0.125,
  st1: 0.045,
  sc1: 0.015,
};

// ALB pricing per hour (fixed component)
export const ALB_HOURLY = 0.0225;
export const ALB_LCU_HOURLY = 0.008;

// NAT Gateway pricing
export const NAT_HOURLY = 0.045;
export const NAT_PER_GB = 0.045;

// EKS control plane
export const EKS_HOURLY = 0.1;

export const CACHE_TTL = 86400; // 24 hours in seconds

// AWS Bulk Pricing API base URL.
// Service codes used: AmazonEC2, AmazonRDS, AmazonEBS
export const BULK_PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

/**
 * AWS instance sizes follow a predictable doubling pattern:
 * nano -> micro -> small -> medium -> large -> xlarge -> 2xlarge -> 4xlarge -> ...
 * Each step roughly doubles the price.
 *
 * Delegated to the shared `interpolateByStepOrder` utility.
 */
export const SIZE_ORDER: readonly string[] = [
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
  "4xlarge",
  "8xlarge",
  "12xlarge",
  "16xlarge",
  "24xlarge",
  "32xlarge",
  "48xlarge",
];

// ---------------------------------------------------------------------------
// Regional price multiplier lookup – reads from the shared data file so all
// providers use consistent values sourced from one place.
// ---------------------------------------------------------------------------

export function regionMultiplier(region: string): number {
  const multipliers = getRegionPriceMultipliers();
  const mult = multipliers.aws[region.toLowerCase()];
  if (mult === undefined) {
    logger.warn("region-multiplier: unknown AWS region, defaulting to 1.0x", { region });
    return 1.0;
  }
  return mult;
}
