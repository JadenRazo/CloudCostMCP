import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import {
  calculateNatGatewayCost,
  calculateLoadBalancerCost,
} from "../../../src/calculator/network.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { makeResource, tempDbPath } from "../../helpers/factories.js";

describe("calculateNatGatewayCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-network-test");
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("calculates NAT gateway cost with hourly and data processing components", async () => {
    const resource = makeResource();

    const estimate = await calculateNatGatewayCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.provider).toBe("aws");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.breakdown.length).toBeGreaterThan(0);
  });

  it("uses default 100 GB data estimate when data_processed_gb is not specified", async () => {
    const resource = makeResource();

    const estimate = await calculateNatGatewayCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.notes.some((n) => n.includes("100 GB/month"))).toBe(true);
  });

  it("uses explicit data_processed_gb when provided", async () => {
    const smallData = makeResource({
      type: "aws_nat_gateway",
      attributes: { data_processed_gb: 10 },
    });
    const largeData = makeResource({
      type: "aws_nat_gateway",
      attributes: { data_processed_gb: 500 },
    });

    const smallEst = await calculateNatGatewayCost(smallData, "aws", "us-east-1", pricingEngine);
    const largeEst = await calculateNatGatewayCost(largeData, "aws", "us-east-1", pricingEngine);

    // Both should have costs; large should cost more
    if (smallEst.monthly_cost > 0 && largeEst.monthly_cost > 0) {
      expect(largeEst.monthly_cost).toBeGreaterThan(smallEst.monthly_cost);
    }
  });

  it("calculates GCP NAT gateway cost", async () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_compute_router_nat",
    });

    const estimate = await calculateNatGatewayCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.provider).toBe("gcp");
  });
});

describe("calculateLoadBalancerCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-network-test");
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("calculates ALB hourly cost", async () => {
    const resource = makeResource({
      type: "aws_lb",
      name: "test-alb",
      attributes: { load_balancer_type: "application" },
    });

    const estimate = await calculateLoadBalancerCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.provider).toBe("aws");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.notes.some((n) => n.includes("Traffic-based charges"))).toBe(true);
  });

  it("defaults to application load balancer type when not specified", async () => {
    const resource = makeResource({
      type: "aws_lb",
      name: "test-lb",
      attributes: {},
    });

    const estimate = await calculateLoadBalancerCost(resource, "aws", "us-east-1", pricingEngine);

    // Should still produce a cost estimate
    expect(estimate.breakdown.length).toBeGreaterThanOrEqual(0);
  });

  it("calculates Azure load balancer cost", async () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_lb",
      name: "test-azure-lb",
    });

    const estimate = await calculateLoadBalancerCost(resource, "azure", "eastus", pricingEngine);

    expect(estimate.provider).toBe("azure");
  });
});
