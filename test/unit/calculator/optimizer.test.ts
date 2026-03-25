import { describe, it, expect, vi } from "vitest";
import { generateOptimizations } from "../../../src/calculator/optimizer.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { CostEstimate } from "../../../src/types/pricing.js";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test",
    type: "aws_instance",
    name: "test",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<CostEstimate>): CostEstimate {
  return {
    resource_id: "test",
    resource_type: "aws_instance",
    resource_name: "test",
    provider: "aws",
    region: "us-east-1",
    monthly_cost: 100,
    yearly_cost: 1200,
    currency: "USD",
    breakdown: [],
    confidence: "high",
    notes: [],
    pricing_source: "fallback",
    ...overrides,
  };
}

describe("generateOptimizations", () => {
  it("returns empty array when no estimates are provided", () => {
    const result = generateOptimizations([], []);
    expect(result).toEqual([]);
  });

  it("recommends right-sizing for oversized instances", () => {
    const resource = makeResource({
      id: "vm-1",
      type: "aws_instance",
      attributes: { instance_type: "m5.2xlarge" },
      tags: {},
    });

    const estimate = makeEstimate({
      resource_id: "vm-1",
      monthly_cost: 200,
    });

    const result = generateOptimizations([estimate], [resource]);

    const rightSize = result.find((r) => r.type === "right_size");
    expect(rightSize).toBeDefined();
    expect(rightSize!.percentage_savings).toBe(30);
    expect(rightSize!.monthly_savings).toBeCloseTo(60, 0);
  });

  it("does not recommend right-sizing for small instances", () => {
    const resource = makeResource({
      id: "vm-1",
      type: "aws_instance",
      attributes: { instance_type: "t3.small" },
      tags: {},
    });

    const estimate = makeEstimate({ resource_id: "vm-1" });

    const result = generateOptimizations([estimate], [resource]);

    const rightSize = result.find((r) => r.type === "right_size");
    expect(rightSize).toBeUndefined();
  });

  it("does not recommend right-sizing when production tags are present", () => {
    const resource = makeResource({
      id: "vm-1",
      type: "aws_instance",
      attributes: { instance_type: "m5.2xlarge" },
      tags: { environment: "production" },
    });

    const estimate = makeEstimate({ resource_id: "vm-1", monthly_cost: 200 });

    const result = generateOptimizations([estimate], [resource]);

    const rightSize = result.find((r) => r.type === "right_size");
    expect(rightSize).toBeUndefined();
  });

  it("recommends reserved instances for compute resources", () => {
    const resource = makeResource({
      id: "vm-1",
      type: "aws_instance",
      attributes: { instance_type: "t3.large" },
    });

    const estimate = makeEstimate({
      resource_id: "vm-1",
      monthly_cost: 100,
    });

    const result = generateOptimizations([estimate], [resource]);

    const reserved = result.find((r) => r.type === "reserved");
    expect(reserved).toBeDefined();
    expect(reserved!.percentage_savings).toBeGreaterThanOrEqual(20);
  });

  it("recommends reserved instances for database resources", () => {
    const resource = makeResource({
      id: "db-1",
      type: "aws_db_instance",
      attributes: { instance_class: "db.t3.medium" },
    });

    const estimate = makeEstimate({
      resource_id: "db-1",
      resource_type: "aws_db_instance",
      monthly_cost: 50,
    });

    const result = generateOptimizations([estimate], [resource]);

    const reserved = result.find((r) => r.type === "reserved");
    expect(reserved).toBeDefined();
  });

  it("recommends switching provider when savings exceed 20%", () => {
    const resource = makeResource({ id: "vm-1" });

    const awsEstimate = makeEstimate({
      resource_id: "vm-1",
      provider: "aws",
      monthly_cost: 100,
    });

    const gcpEstimate = makeEstimate({
      resource_id: "vm-1",
      provider: "gcp",
      monthly_cost: 70, // 30% cheaper
    });

    const result = generateOptimizations([awsEstimate, gcpEstimate], [resource]);

    const switchProvider = result.find((r) => r.type === "switch_provider");
    expect(switchProvider).toBeDefined();
    expect(switchProvider!.provider).toBe("gcp");
    expect(switchProvider!.percentage_savings).toBeCloseTo(30, 0);
  });

  it("does not recommend switching provider when savings are under 20%", () => {
    const resource = makeResource({ id: "vm-1" });

    const awsEstimate = makeEstimate({
      resource_id: "vm-1",
      provider: "aws",
      monthly_cost: 100,
    });

    const gcpEstimate = makeEstimate({
      resource_id: "vm-1",
      provider: "gcp",
      monthly_cost: 90, // only 10% cheaper
    });

    const result = generateOptimizations([awsEstimate, gcpEstimate], [resource]);

    const switchProvider = result.find((r) => r.type === "switch_provider");
    expect(switchProvider).toBeUndefined();
  });

  it("recommends storage tier change for hot-tier S3 buckets", () => {
    const resource = makeResource({
      id: "s3-1",
      type: "aws_s3_bucket",
      attributes: { storage_class: "STANDARD" },
    });

    const estimate = makeEstimate({
      resource_id: "s3-1",
      resource_type: "aws_s3_bucket",
      monthly_cost: 50,
    });

    const result = generateOptimizations([estimate], [resource]);

    const storageTier = result.find((r) => r.type === "storage_tier");
    expect(storageTier).toBeDefined();
    expect(storageTier!.percentage_savings).toBe(40);
  });

  it("does not recommend storage tier change for non-hot storage classes", () => {
    const resource = makeResource({
      id: "s3-1",
      type: "aws_s3_bucket",
      attributes: { storage_class: "GLACIER" },
    });

    const estimate = makeEstimate({
      resource_id: "s3-1",
      resource_type: "aws_s3_bucket",
      monthly_cost: 10,
    });

    const result = generateOptimizations([estimate], [resource]);

    const storageTier = result.find((r) => r.type === "storage_tier");
    expect(storageTier).toBeUndefined();
  });

  it("skips recommendations for zero-cost resources", () => {
    const resource = makeResource({ id: "vm-1", type: "aws_instance" });
    const estimate = makeEstimate({ resource_id: "vm-1", monthly_cost: 0 });

    const result = generateOptimizations([estimate], [resource]);

    expect(result).toHaveLength(0);
  });
});
