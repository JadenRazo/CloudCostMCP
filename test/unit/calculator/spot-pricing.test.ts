import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { CloudCostConfig } from "../../../src/types/config.js";

// Disable live network fetches for deterministic unit tests.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-spot-test-${suffix}`, "cache.db");
}

function makeConfig(
  overrides: Partial<CloudCostConfig["pricing"]> = {}
): CloudCostConfig {
  return {
    ...DEFAULT_CONFIG,
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...overrides,
    },
  };
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_instance",
    name: "test-resource",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// Helper: build a CostEngine with a given pricing_model.
function makeEngine(
  cache: PricingCache,
  pricingModelOverride?: CloudCostConfig["pricing"]["pricing_model"]
): CostEngine {
  const config = makeConfig(
    pricingModelOverride ? { pricing_model: pricingModelOverride } : undefined
  );
  const pricingEngine = new PricingEngine(cache, config);
  return new CostEngine(pricingEngine, config);
}

describe("Spot pricing — CostEngine integration", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Default on-demand behaviour is unchanged
  // ---------------------------------------------------------------------------

  it("on-demand pricing_model leaves cost unchanged", async () => {
    const resource = makeResource({
      id: "aws-vm-1",
      type: "aws_instance",
      name: "web",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.large" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const estimate = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");

    // t3.large fallback = $0.0832/hr * 730
    expect(estimate.monthly_cost).toBeCloseTo(0.0832 * 730, 0);
    expect(estimate.pricing_source).not.toBe("spot-estimate");
    expect(estimate.notes.some((n) => n.includes("Spot pricing"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Spot pricing reduces cost vs on-demand
  // ---------------------------------------------------------------------------

  it("spot pricing reduces monthly cost compared to on-demand for AWS general instance", async () => {
    const resource = makeResource({
      id: "aws-vm-2",
      type: "aws_instance",
      name: "web",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.large" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");
    const spot = await spotEngine.calculateCost(resource, "aws", "us-east-1");

    expect(spot.monthly_cost).toBeLessThan(onDemand.monthly_cost);
    // AWS general factor = 0.35, so spot should be 35% of on-demand.
    expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.35, 1);
  });

  // ---------------------------------------------------------------------------
  // pricing_source is set to "spot-estimate"
  // ---------------------------------------------------------------------------

  it("sets pricing_source to spot-estimate when spot model is used", async () => {
    const resource = makeResource({
      id: "aws-vm-3",
      type: "aws_instance",
      name: "app",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "m5.xlarge" },
    });

    const engine = makeEngine(cache, "spot");
    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    expect(estimate.pricing_source).toBe("spot-estimate");
  });

  // ---------------------------------------------------------------------------
  // Spot note is present in the estimate
  // ---------------------------------------------------------------------------

  it("includes a note describing the spot discount percentage", async () => {
    const resource = makeResource({
      id: "aws-vm-4",
      type: "aws_instance",
      name: "app",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "m5.xlarge" },
    });

    const engine = makeEngine(cache, "spot");
    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    const spotNote = estimate.notes.find((n) => n.includes("Spot pricing applied"));
    expect(spotNote).toBeDefined();
    // AWS general factor = 0.35, so savings = 65%.
    expect(spotNote).toContain("65%");
  });

  // ---------------------------------------------------------------------------
  // Correct discount per instance family — AWS compute family (c5)
  // ---------------------------------------------------------------------------

  it("applies compute family discount factor (30%) for c5 instances on AWS", async () => {
    const resource = makeResource({
      id: "aws-vm-c5",
      type: "aws_instance",
      name: "compute-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "c5.xlarge" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");
    const spot = await spotEngine.calculateCost(resource, "aws", "us-east-1");

    // AWS compute factor = 0.30 → 70% savings.
    expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.30, 1);
    const spotNote = spot.notes.find((n) => n.includes("Spot pricing applied"));
    expect(spotNote).toContain("70%");
  });

  // ---------------------------------------------------------------------------
  // Correct discount per instance family — AWS memory family (r5)
  // ---------------------------------------------------------------------------

  it("applies memory family discount factor (35%) for r5 instances on AWS", async () => {
    const resource = makeResource({
      id: "aws-vm-r5",
      type: "aws_instance",
      name: "memory-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "r5.xlarge" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");
    const spot = await spotEngine.calculateCost(resource, "aws", "us-east-1");

    // AWS memory factor = 0.35 → 65% savings.
    expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.35, 1);
  });

  // ---------------------------------------------------------------------------
  // Correct discount per instance family — AWS GPU family (p3)
  // ---------------------------------------------------------------------------

  it("applies GPU family discount factor (40%) for g4dn instances on AWS", async () => {
    // g4dn instances have fallback pricing; p3 do not.
    const resource = makeResource({
      id: "aws-vm-g4dn",
      type: "aws_instance",
      name: "gpu-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "g4dn.xlarge" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");
    const spot = await spotEngine.calculateCost(resource, "aws", "us-east-1");

    // AWS gpu factor = 0.40 → 60% savings.
    if (onDemand.monthly_cost > 0) {
      expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.40, 1);
      const spotNote = spot.notes.find((n) => n.includes("Spot pricing applied"));
      expect(spotNote).toBeDefined();
      expect(spotNote).toContain("60%");
    }
  });

  // ---------------------------------------------------------------------------
  // Correct discount per provider — GCP general instance (n2)
  // ---------------------------------------------------------------------------

  it("applies GCP general discount factor (30%) for n2 instances", async () => {
    const resource = makeResource({
      id: "gcp-vm-n2",
      type: "google_compute_instance",
      name: "gcp-server",
      provider: "gcp",
      region: "us-central1",
      attributes: { machine_type: "n2-standard-4" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "gcp", "us-central1");
    const spot = await spotEngine.calculateCost(resource, "gcp", "us-central1");

    // GCP general factor = 0.30 → 70% savings.
    if (onDemand.monthly_cost > 0) {
      expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.30, 1);
      expect(spot.pricing_source).toBe("spot-estimate");
    }
  });

  // ---------------------------------------------------------------------------
  // Correct discount per provider — Azure general instance (Standard_D)
  // ---------------------------------------------------------------------------

  it("applies Azure general discount factor (35%) for Standard_D instances", async () => {
    const resource = makeResource({
      id: "azure-vm-d",
      type: "azurerm_linux_virtual_machine",
      name: "azure-server",
      provider: "azure",
      region: "eastus",
      attributes: { vm_size: "Standard_D4s_v3" },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "azure", "eastus");
    const spot = await spotEngine.calculateCost(resource, "azure", "eastus");

    // Azure general factor = 0.35 → 65% savings.
    if (onDemand.monthly_cost > 0) {
      expect(spot.monthly_cost).toBeCloseTo(onDemand.monthly_cost * 0.35, 1);
      expect(spot.pricing_source).toBe("spot-estimate");
    }
  });

  // ---------------------------------------------------------------------------
  // Spot pricing does not affect storage cost component
  // ---------------------------------------------------------------------------

  it("spot discount applies only to compute, not to attached storage", async () => {
    const resource = makeResource({
      id: "aws-vm-disk",
      type: "aws_instance",
      name: "with-disk",
      provider: "aws",
      region: "us-east-1",
      attributes: {
        instance_type: "t3.large",
        root_block_device: { volume_type: "gp3", volume_size: 100 },
      },
    });

    const onDemandEngine = makeEngine(cache, "on-demand");
    const spotEngine = makeEngine(cache, "spot");

    const onDemand = await onDemandEngine.calculateCost(resource, "aws", "us-east-1");
    const spot = await spotEngine.calculateCost(resource, "aws", "us-east-1");

    // Find line items in each estimate.
    const odCompute = onDemand.breakdown.find((b) => b.unit === "Hrs");
    const odStorage = onDemand.breakdown.find((b) => b.unit === "GB-Mo");
    const spCompute = spot.breakdown.find((b) => b.unit === "Hrs");
    const spStorage = spot.breakdown.find((b) => b.unit === "GB-Mo");

    // Compute should be discounted.
    if (odCompute && spCompute) {
      expect(spCompute.monthly_cost).toBeCloseTo(odCompute.monthly_cost * 0.35, 1);
    }

    // Storage cost should be identical between on-demand and spot.
    if (odStorage && spStorage) {
      expect(spStorage.monthly_cost).toBeCloseTo(odStorage.monthly_cost, 4);
    }
  });
});
