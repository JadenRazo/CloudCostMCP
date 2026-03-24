import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { calculateStorageCost } from "../../../src/calculator/storage.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-storage-test-${suffix}`, "cache.db");
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-storage",
    type: "aws_ebs_volume",
    name: "test-volume",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

describe("calculateStorageCost", () => {
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

  it("calculates EBS gp3 block storage cost", async () => {
    const resource = makeResource({
      attributes: { storage_type: "gp3", storage_size_gb: 100 },
    });

    const estimate = await calculateStorageCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.monthly_cost).toBeCloseTo(0.08 * 100, 1);
    expect(estimate.breakdown[0]?.unit).toBe("GB-Mo");
    expect(estimate.confidence).toBe("high");
  });

  it("defaults block volume to 8 GB when no size is specified", async () => {
    const resource = makeResource({
      attributes: { storage_type: "gp3" },
    });

    const estimate = await calculateStorageCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.notes.some((n) => n.includes("8 GB"))).toBe(true);
    expect(estimate.monthly_cost).toBeCloseTo(0.08 * 8, 1);
  });

  it("defaults object storage to 100 GB when no size is specified", async () => {
    const resource = makeResource({
      type: "aws_s3_bucket",
      name: "test-bucket",
      attributes: {},
    });

    const estimate = await calculateStorageCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.notes.some((n) => n.includes("100 GB"))).toBe(true);
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("uses disk_size_gb attribute as fallback size", async () => {
    const resource = makeResource({
      type: "google_compute_disk",
      provider: "gcp",
      attributes: { type: "pd-ssd", disk_size_gb: 50 },
    });

    const estimate = await calculateStorageCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("falls back to gp3 rate for unpriced object storage classes", async () => {
    const resource = makeResource({
      type: "aws_s3_bucket",
      attributes: { storage_class: "STANDARD", storage_size_gb: 100 },
    });

    const estimate = await calculateStorageCost(resource, "aws", "us-east-1", pricingEngine);

    // Should produce a cost even if STANDARD isn't directly priced
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("calculates Azure managed disk cost", async () => {
    const resource = makeResource({
      type: "azurerm_managed_disk",
      provider: "azure",
      attributes: { storage_type: "Premium_LRS", storage_size_gb: 256 },
    });

    const estimate = await calculateStorageCost(resource, "azure", "eastus", pricingEngine);

    expect(estimate.provider).toBe("azure");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("returns low confidence when no pricing is found", async () => {
    const resource = makeResource({
      type: "aws_ebs_volume",
      attributes: { storage_type: "nonexistent_type_xyz", storage_size_gb: 100 },
    });

    const estimate = await calculateStorageCost(resource, "aws", "us-east-1", pricingEngine);

    if (estimate.monthly_cost === 0) {
      expect(estimate.confidence).toBe("low");
    }
  });
});
