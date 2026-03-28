import { describe, it, expect } from "vitest";
import {
  calculateElastiCacheCost,
  calculateAzureRedisCacheCost,
  calculateGcpRedisCost,
  calculateCloudFrontCost,
} from "../../../src/calculator/cache.js";
import type { ParsedResource } from "../../../src/types/resources.js";

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_elasticache_cluster",
    name: "test-cache",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ElastiCache
// ---------------------------------------------------------------------------

describe("calculateElastiCacheCost", () => {
  it("calculates cost for cache.t3.micro single node", () => {
    const resource = makeResource({
      type: "aws_elasticache_cluster",
      attributes: { instance_type: "cache.t3.micro", node_count: 1, engine: "redis" },
    });
    const estimate = calculateElastiCacheCost(resource, "aws", "us-east-1");

    // cache.t3.micro = $0.017/hr * 730 = $12.41
    expect(estimate.monthly_cost).toBeCloseTo(0.017 * 730, 1);
    expect(estimate.breakdown[0]!.description).toContain("redis");
    expect(estimate.confidence).toBe("medium");
  });

  it("multiplies cost by node count", () => {
    const single = makeResource({
      attributes: { instance_type: "cache.t3.micro", node_count: 1 },
    });
    const cluster = makeResource({
      attributes: { instance_type: "cache.t3.micro", node_count: 3 },
    });

    const singleEst = calculateElastiCacheCost(single, "aws", "us-east-1");
    const clusterEst = calculateElastiCacheCost(cluster, "aws", "us-east-1");

    expect(clusterEst.monthly_cost).toBeCloseTo(singleEst.monthly_cost * 3, 1);
  });

  it("returns low confidence for unknown node type", () => {
    const resource = makeResource({
      attributes: { instance_type: "cache.r99.unknown" },
    });
    const estimate = calculateElastiCacheCost(resource, "aws", "us-east-1");

    expect(estimate.monthly_cost).toBe(0);
    expect(estimate.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Azure Redis Cache
// ---------------------------------------------------------------------------

describe("calculateAzureRedisCacheCost", () => {
  it("calculates Standard C1 pricing", () => {
    const resource = makeResource({
      type: "azurerm_redis_cache",
      provider: "azure",
      attributes: { sku: "Standard", family: "C", capacity: 1 },
    });
    const estimate = calculateAzureRedisCacheCost(resource, "azure", "eastus");

    // Standard C1 = $0.10/hr * 730 = $73
    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 730, 1);
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates Premium P1 pricing", () => {
    const resource = makeResource({
      type: "azurerm_redis_cache",
      provider: "azure",
      attributes: { sku: "Premium", family: "P", capacity: 1 },
    });
    const estimate = calculateAzureRedisCacheCost(resource, "azure", "eastus");

    // Premium P1 = $0.348/hr * 730 = $254.04
    expect(estimate.monthly_cost).toBeCloseTo(0.348 * 730, 1);
  });

  it("returns low confidence for unknown tier", () => {
    const resource = makeResource({
      type: "azurerm_redis_cache",
      provider: "azure",
      attributes: { sku: "Ultra", family: "X", capacity: 99 },
    });
    const estimate = calculateAzureRedisCacheCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBe(0);
    expect(estimate.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// GCP Redis
// ---------------------------------------------------------------------------

describe("calculateGcpRedisCost", () => {
  it("calculates BASIC tier pricing", () => {
    const resource = makeResource({
      type: "google_redis_instance",
      provider: "gcp",
      attributes: { tier: "BASIC", memory_size: 1 },
    });
    const estimate = calculateGcpRedisCost(resource, "gcp", "us-central1");

    // BASIC: $0.049/GB/hr * 1GB * 730hr = $35.77
    expect(estimate.monthly_cost).toBeCloseTo(0.049 * 730, 1);
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates STANDARD_HA tier is 2x BASIC", () => {
    const basic = makeResource({
      type: "google_redis_instance",
      provider: "gcp",
      attributes: { tier: "BASIC", memory_size: 4 },
    });
    const ha = makeResource({
      type: "google_redis_instance",
      provider: "gcp",
      attributes: { tier: "STANDARD_HA", memory_size: 4 },
    });

    const basicEst = calculateGcpRedisCost(basic, "gcp", "us-central1");
    const haEst = calculateGcpRedisCost(ha, "gcp", "us-central1");

    expect(haEst.monthly_cost).toBeCloseTo(basicEst.monthly_cost * 2, 1);
  });
});

// ---------------------------------------------------------------------------
// CloudFront
// ---------------------------------------------------------------------------

describe("calculateCloudFrontCost", () => {
  it("calculates 100GB default transfer", () => {
    const resource = makeResource({
      type: "aws_cloudfront_distribution",
      attributes: {},
    });
    const estimate = calculateCloudFrontCost(resource, "aws", "us-east-1");

    // 100GB * $0.085 = $8.50
    expect(estimate.monthly_cost).toBeCloseTo(100 * 0.085, 2);
    expect(estimate.notes.some((n) => n.includes("Default data transfer assumption"))).toBe(true);
  });

  it("uses provided monthly_transfer_gb", () => {
    const resource = makeResource({
      type: "aws_cloudfront_distribution",
      attributes: { monthly_transfer_gb: 500 },
    });
    const estimate = calculateCloudFrontCost(resource, "aws", "us-east-1");

    expect(estimate.monthly_cost).toBeCloseTo(500 * 0.085, 2);
    expect(estimate.notes.some((n) => n.includes("Default data transfer assumption"))).toBe(false);
  });

  it("includes price_class in notes", () => {
    const resource = makeResource({
      type: "aws_cloudfront_distribution",
      attributes: { price_class: "PriceClass_100" },
    });
    const estimate = calculateCloudFrontCost(resource, "aws", "us-east-1");

    expect(estimate.notes.some((n) => n.includes("PriceClass_100"))).toBe(true);
  });
});
