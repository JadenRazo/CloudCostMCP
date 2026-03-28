import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { calculateComputeCost } from "../../../src/calculator/compute.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { PricingConfig } from "../../../src/types/config.js";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-compute-test-${suffix}`, "cache.db");
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-compute",
    type: "aws_instance",
    name: "test-vm",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

describe("calculateComputeCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns a cost estimate for a known AWS instance type", async () => {
    const resource = makeResource({
      attributes: { instance_type: "t3.large" },
    });

    const estimate = await calculateComputeCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 0);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.breakdown.length).toBeGreaterThan(0);
  });

  it("uses vm_size attribute for Azure resources", async () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_linux_virtual_machine",
      attributes: { vm_size: "Standard_B2ms" },
    });

    const estimate = await calculateComputeCost(resource, "azure", "eastus", pricingEngine);

    expect(estimate.provider).toBe("azure");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("uses machine_type attribute for GCP resources", async () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_compute_instance",
      attributes: { machine_type: "e2-medium" },
    });

    const estimate = await calculateComputeCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.provider).toBe("gcp");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("returns low confidence when no instance type is provided", async () => {
    const resource = makeResource({ attributes: {} });

    const estimate = await calculateComputeCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.confidence).toBe("low");
  });

  it("applies spot pricing discount when pricing_model is spot", async () => {
    const resource = makeResource({
      attributes: { instance_type: "t3.large" },
    });

    const spotConfig: PricingConfig = { ...DEFAULT_CONFIG.pricing, pricing_model: "spot" };

    const onDemand = await calculateComputeCost(
      resource,
      "aws",
      "us-east-1",
      pricingEngine,
      730,
      DEFAULT_CONFIG.pricing,
    );
    const spot = await calculateComputeCost(
      resource,
      "aws",
      "us-east-1",
      pricingEngine,
      730,
      spotConfig,
    );

    expect(spot.monthly_cost).toBeLessThan(onDemand.monthly_cost);
    expect(spot.pricing_source).toBe("spot-estimate");
    expect(spot.notes.some((n) => n.includes("Spot pricing applied"))).toBe(true);
  });

  it("adds root block device storage cost when specified", async () => {
    const withoutDisk = makeResource({
      attributes: { instance_type: "t3.large" },
    });
    const withDisk = makeResource({
      attributes: {
        instance_type: "t3.large",
        root_block_device: { volume_type: "gp3", volume_size: 100 },
      },
    });

    const estNoDisk = await calculateComputeCost(withoutDisk, "aws", "us-east-1", pricingEngine);
    const estDisk = await calculateComputeCost(withDisk, "aws", "us-east-1", pricingEngine);

    expect(estDisk.monthly_cost).toBeGreaterThan(estNoDisk.monthly_cost);
    expect(estDisk.breakdown.length).toBeGreaterThan(estNoDisk.breakdown.length);
  });

  it("respects custom monthlyHours", async () => {
    const resource = makeResource({
      attributes: { instance_type: "t3.large" },
    });

    const full = await calculateComputeCost(resource, "aws", "us-east-1", pricingEngine, 730);
    const half = await calculateComputeCost(resource, "aws", "us-east-1", pricingEngine, 365);

    expect(half.monthly_cost).toBeCloseTo(full.monthly_cost / 2, 0);
  });

  it("cross-provider mapping from AWS to GCP", async () => {
    const resource = makeResource({
      provider: "aws",
      attributes: { instance_type: "t3.large" },
    });

    const estimate = await calculateComputeCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.provider).toBe("gcp");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });
});
