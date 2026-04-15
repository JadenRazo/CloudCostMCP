import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { RDS_BASE_PRICES } from "../../../src/pricing/aws/fallback-data.js";
import type { ParsedResource } from "../../../src/types/resources.js";

// Disable live network fetches; fallback prices in the loaders are sufficient
// for deterministic unit tests.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-engine-test-${suffix}`, "cache.db");
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

describe("CostEngine", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;
  let engine: CostEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
    engine = new CostEngine(pricingEngine, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Compute cost
  // -------------------------------------------------------------------------

  it("calculates compute cost for t3.large on AWS in us-east-1", async () => {
    const resource = makeResource({
      id: "aws-vm-1",
      type: "aws_instance",
      name: "web-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.large" },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    // t3.large fallback price = $0.0832/hr * 730 h = $60.74/month
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.monthly_cost).toBeCloseTo(0.0832 * 730, 0);
    expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 0);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.breakdown.length).toBeGreaterThan(0);
  });

  it("applies the configured monthlyHours (730) to compute estimates", async () => {
    const resource = makeResource({
      id: "aws-vm-2",
      type: "aws_instance",
      name: "app-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.micro" },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");
    // t3.micro = $0.0104/hr; 730 h = $7.59
    expect(estimate.monthly_cost).toBeCloseTo(0.0104 * 730, 1);
  });

  it("cross-provider compute mapping: t3.large AWS -> Azure (Standard_B2ms)", async () => {
    const resource = makeResource({
      id: "aws-vm-3",
      type: "aws_instance",
      name: "mapped-server",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.large" },
    });

    const estimate = await engine.calculateCost(resource, "azure", "eastus");

    expect(estimate.provider).toBe("azure");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    // The breakdown must include at least the compute line item.
    expect(estimate.breakdown.length).toBeGreaterThan(0);
  });

  it("returns a low-confidence estimate with zero cost for an unsupported resource type", async () => {
    const resource = makeResource({
      type: "aws_cloudwatch_metric_alarm",
      name: "cpu-alarm",
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    expect(estimate.monthly_cost).toBe(0);
    expect(estimate.confidence).toBe("low");
    expect(estimate.notes.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Database cost
  // -------------------------------------------------------------------------

  it("calculates database cost for a db.t3.medium RDS instance", async () => {
    const resource = makeResource({
      id: "db-1",
      type: "aws_db_instance",
      name: "main-db",
      provider: "aws",
      region: "us-east-1",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 100,
      },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    // Drive the expected cost off the live fallback table so the weekly
    // pricing refresh script's output does not break this assertion.
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    const instanceCost = RDS_BASE_PRICES["db.t3.medium"]! * 730;
    const storageCost = 100 * 0.08;
    expect(estimate.monthly_cost).toBeCloseTo(instanceCost + storageCost, 0);
  });

  it("doubles instance cost for multi-AZ RDS", async () => {
    const singleAz = makeResource({
      id: "db-single",
      type: "aws_db_instance",
      name: "single-az-db",
      provider: "aws",
      region: "us-east-1",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 0,
        multi_az: false,
      },
    });

    const multiAz = makeResource({
      id: "db-multi",
      type: "aws_db_instance",
      name: "multi-az-db",
      provider: "aws",
      region: "us-east-1",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 0,
        multi_az: true,
      },
    });

    const singleEstimate = await engine.calculateCost(singleAz, "aws", "us-east-1");
    const multiEstimate = await engine.calculateCost(multiAz, "aws", "us-east-1");

    // Multi-AZ should cost roughly 2x the single-AZ instance cost.
    expect(multiEstimate.monthly_cost).toBeCloseTo(singleEstimate.monthly_cost * 2, 0);
  });

  // -------------------------------------------------------------------------
  // Storage cost
  // -------------------------------------------------------------------------

  it("calculates EBS block storage cost (gp3, 100 GB)", async () => {
    const resource = makeResource({
      id: "ebs-1",
      type: "aws_ebs_volume",
      name: "data-volume",
      provider: "aws",
      region: "us-east-1",
      attributes: {
        storage_type: "gp3",
        storage_size_gb: 100,
      },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    // gp3 = $0.08/GB-Mo * 100 GB = $8.00/month
    expect(estimate.monthly_cost).toBeCloseTo(0.08 * 100, 1);
    expect(estimate.breakdown[0].unit).toBe("GB-Mo");
  });

  it("calculates S3 object storage cost using default size assumption when unspecified", async () => {
    const resource = makeResource({
      id: "s3-1",
      type: "aws_s3_bucket",
      name: "my-bucket",
      provider: "aws",
      region: "us-east-1",
      attributes: {},
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");

    // Should produce a non-zero estimate using the 100 GB default assumption.
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CostBreakdown aggregation
  // -------------------------------------------------------------------------

  it("calculateBreakdown aggregates by_service totals correctly", async () => {
    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
      makeResource({
        id: "vm-2",
        type: "aws_instance",
        name: "api",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.small" },
      }),
      makeResource({
        id: "ebs-1",
        type: "aws_ebs_volume",
        name: "disk",
        provider: "aws",
        region: "us-east-1",
        attributes: { storage_type: "gp3", storage_size_gb: 50 },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.provider).toBe("aws");
    // 3 real resources + 1 synthetic data transfer line item
    expect(breakdown.by_resource).toHaveLength(4);
    expect(breakdown.total_monthly).toBeGreaterThan(0);
    // total_yearly is rounded independently; allow up to $0.12 rounding gap.
    expect(Math.abs(breakdown.total_yearly - breakdown.total_monthly * 12)).toBeLessThan(0.12);

    // The "compute" service bucket should include both VM estimates.
    expect(breakdown.by_service["compute"]).toBeGreaterThan(0);
    expect(breakdown.by_service["block_storage"]).toBeGreaterThan(0);
    // Data transfer service bucket should appear.
    expect(breakdown.by_service["data_transfer"]).toBeGreaterThan(0);

    // Verify total = sum of by_resource costs (including data transfer).
    const manualSum = breakdown.by_resource.reduce((sum, e) => sum + e.monthly_cost, 0);
    expect(breakdown.total_monthly).toBeCloseTo(manualSum, 1);
  });

  it("calculateBreakdown sets generated_at to a recent ISO timestamp", async () => {
    const before = Date.now();
    const breakdown = await engine.calculateBreakdown([], "aws", "us-east-1");
    const after = Date.now();

    const ts = new Date(breakdown.generated_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("calculateBreakdown handles an empty resource list gracefully", async () => {
    const breakdown = await engine.calculateBreakdown([], "gcp", "us-central1");

    expect(breakdown.total_monthly).toBe(0);
    expect(breakdown.total_yearly).toBe(0);
    expect(breakdown.by_resource).toHaveLength(0);
    expect(breakdown.by_service).toEqual({});
  });
});
