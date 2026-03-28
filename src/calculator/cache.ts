import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

const MONTHLY_HOURS = 730;

// ---------------------------------------------------------------------------
// AWS ElastiCache pricing (approximate us-east-1 on-demand, 2024)
// ---------------------------------------------------------------------------

const ELASTICACHE_NODE_PRICES: Record<string, number> = {
  // cache.t3.* nodes
  "cache.t3.micro": 0.017,
  "cache.t3.small": 0.034,
  "cache.t3.medium": 0.068,
  // cache.t4g.* nodes (Graviton2)
  "cache.t4g.micro": 0.016,
  "cache.t4g.small": 0.032,
  "cache.t4g.medium": 0.065,
  // cache.m5.* nodes
  "cache.m5.large": 0.122,
  "cache.m5.xlarge": 0.244,
  "cache.m5.2xlarge": 0.488,
  "cache.m5.4xlarge": 0.976,
  // cache.m6g.* nodes (Graviton2)
  "cache.m6g.large": 0.103,
  "cache.m6g.xlarge": 0.206,
  "cache.m6g.2xlarge": 0.413,
  // cache.r5.* nodes
  "cache.r5.large": 0.166,
  "cache.r5.xlarge": 0.332,
  "cache.r5.2xlarge": 0.664,
  // cache.r6g.* nodes (Graviton2)
  "cache.r6g.large": 0.148,
  "cache.r6g.xlarge": 0.296,
  "cache.r6g.2xlarge": 0.592,
};

/**
 * Calculates the monthly cost for an AWS ElastiCache cluster or replication group.
 *
 * Cost = node_hourly_price * monthly_hours * num_cache_nodes
 */
export function calculateElastiCacheCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const nodeType = (resource.attributes.instance_type as string | undefined) ?? "cache.t3.micro";
  const numNodes = (resource.attributes.node_count as number | undefined) ?? 1;
  const engine = (resource.attributes.engine as string | undefined) ?? "redis";

  const basePrice = ELASTICACHE_NODE_PRICES[nodeType.toLowerCase()];
  let totalMonthly = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (basePrice !== undefined) {
    const nodeCost = basePrice * MONTHLY_HOURS;
    const clusterCost = nodeCost * numNodes;
    totalMonthly = clusterCost;

    breakdown.push({
      description: `ElastiCache ${engine} ${nodeType} x${numNodes} (${MONTHLY_HOURS}h/month)`,
      unit: "Hrs",
      quantity: numNodes * MONTHLY_HOURS,
      unit_price: basePrice,
      monthly_cost: clusterCost,
    });

    pricingSource = "fallback";
    notes.push(`ElastiCache ${engine} cluster: ${numNodes} x ${nodeType}`);
  } else {
    notes.push(`No pricing data found for ElastiCache node type ${nodeType}; cost reported as $0`);
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
    confidence: basePrice !== undefined ? "medium" : "low",
    notes,
    pricing_source: pricingSource,
  };
}

// ---------------------------------------------------------------------------
// Azure Redis Cache pricing
// ---------------------------------------------------------------------------

// Hourly prices for Azure Redis Cache by SKU tier and capacity
// Format: "sku:capacity" -> hourly price
const AZURE_REDIS_PRICES: Record<string, number> = {
  // Basic (single node, no SLA)
  "basic:c0": 0.022,
  "basic:c1": 0.055,
  "basic:c2": 0.148,
  "basic:c3": 0.558,
  "basic:c4": 1.302,
  "basic:c5": 2.604,
  "basic:c6": 5.207,
  // Standard (two-node primary/replica)
  "standard:c0": 0.055,
  "standard:c1": 0.1,
  "standard:c2": 0.296,
  "standard:c3": 1.116,
  "standard:c4": 2.604,
  "standard:c5": 5.207,
  "standard:c6": 10.415,
  // Premium (cluster with Redis persistence and VNet injection)
  "premium:p1": 0.348,
  "premium:p2": 0.696,
  "premium:p3": 1.392,
  "premium:p4": 2.784,
  "premium:p5": 5.568,
};

/**
 * Calculates the monthly cost for an Azure Redis Cache instance.
 *
 * Pricing depends on SKU (Basic/Standard/Premium) and capacity (C0..C6 / P1..P5).
 */
export function calculateAzureRedisCacheCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const sku = ((resource.attributes.sku as string | undefined) ?? "Standard").toLowerCase();
  const family = ((resource.attributes.family as string | undefined) ?? "C").toLowerCase();
  const capacity = (resource.attributes.capacity as number | undefined) ?? 1;

  // Build lookup key: "standard:c1"
  const capacityStr = `${family}${capacity}`;
  const lookupKey = `${sku}:${capacityStr}`;

  const hourlyPrice = AZURE_REDIS_PRICES[lookupKey];
  let totalMonthly = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (hourlyPrice !== undefined) {
    totalMonthly = hourlyPrice * MONTHLY_HOURS;

    breakdown.push({
      description: `Azure Redis Cache ${sku} ${capacityStr.toUpperCase()} (${MONTHLY_HOURS}h/month)`,
      unit: "Hrs",
      quantity: MONTHLY_HOURS,
      unit_price: hourlyPrice,
      monthly_cost: totalMonthly,
    });

    pricingSource = "fallback";
    notes.push(`Azure Redis Cache: ${sku} tier, ${capacityStr.toUpperCase()} capacity`);
  } else {
    notes.push(
      `No pricing found for Azure Redis Cache ${sku} ${capacityStr.toUpperCase()}; cost reported as $0`,
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
    confidence: hourlyPrice !== undefined ? "medium" : "low",
    notes,
    pricing_source: pricingSource,
  };
}

// ---------------------------------------------------------------------------
// GCP Memorystore (Redis) pricing
// ---------------------------------------------------------------------------

// Price per GB per hour
const GCP_REDIS_PRICES: Record<string, number> = {
  basic: 0.049,
  standard_ha: 0.098,
};

/**
 * Calculates the monthly cost for a GCP Memorystore Redis instance.
 *
 * Basic:       $0.049/GB/hr
 * Standard_HA: $0.098/GB/hr
 */
export function calculateGcpRedisCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const tier = ((resource.attributes.tier as string | undefined) ?? "BASIC").toLowerCase();
  const memorySizeGb = (resource.attributes.memory_size as number | undefined) ?? 1;

  const normalizedTier = tier === "standard_ha" || tier === "standard" ? "standard_ha" : "basic";
  const pricePerGbHour = GCP_REDIS_PRICES[normalizedTier]!;

  const totalMonthly = pricePerGbHour * memorySizeGb * MONTHLY_HOURS;

  breakdown.push({
    description: `GCP Redis ${normalizedTier.toUpperCase()} (${memorySizeGb}GB, ${MONTHLY_HOURS}h/month)`,
    unit: "GB-Hr",
    quantity: memorySizeGb * MONTHLY_HOURS,
    unit_price: pricePerGbHour,
    monthly_cost: totalMonthly,
  });

  notes.push(
    `GCP Memorystore Redis: ${normalizedTier} tier, ${memorySizeGb}GB — $${pricePerGbHour}/GB/hr`,
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
// AWS CloudFront pricing
// ---------------------------------------------------------------------------

const CLOUDFRONT_DATA_FIRST_10TB_PER_GB = 0.085;
const DEFAULT_CLOUDFRONT_TRANSFER_GB = 100;

/**
 * Calculates the monthly cost for an AWS CloudFront distribution.
 *
 * Cost is primarily data transfer: $0.085/GB for first 10TB.
 * Assumes 100GB/month transfer if unspecified.
 */
export function calculateCloudFrontCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const transferGb =
    (resource.attributes.monthly_transfer_gb as number | undefined) ??
    DEFAULT_CLOUDFRONT_TRANSFER_GB;
  const priceClass = (resource.attributes.price_class as string | undefined) ?? "PriceClass_All";

  // First 10TB tier
  const firstTierGb = Math.min(transferGb, 10 * 1024);
  const firstTierCost = firstTierGb * CLOUDFRONT_DATA_FIRST_10TB_PER_GB;

  // Next 40TB tier (lower rate)
  const secondTierGb = Math.max(0, transferGb - 10 * 1024);
  const secondTierCost = secondTierGb * 0.08; // $0.080/GB for 10-50TB

  const totalMonthly = firstTierCost + secondTierCost;

  if (firstTierGb > 0) {
    breakdown.push({
      description: `CloudFront data transfer first 10TB (${firstTierGb.toFixed(0)}GB/month)`,
      unit: "GB",
      quantity: firstTierGb,
      unit_price: CLOUDFRONT_DATA_FIRST_10TB_PER_GB,
      monthly_cost: firstTierCost,
    });
  }

  if (secondTierGb > 0) {
    breakdown.push({
      description: `CloudFront data transfer 10-50TB (${secondTierGb.toFixed(0)}GB/month)`,
      unit: "GB",
      quantity: secondTierGb,
      unit_price: 0.08,
      monthly_cost: secondTierCost,
    });
  }

  if (!resource.attributes.monthly_transfer_gb) {
    notes.push(
      `Default data transfer assumption: ${DEFAULT_CLOUDFRONT_TRANSFER_GB}GB/month — ` +
        "provide monthly_transfer_gb attribute for accuracy",
    );
  }

  notes.push(
    `CloudFront ${priceClass} — HTTPS request charges excluded (runtime traffic data required)`,
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
