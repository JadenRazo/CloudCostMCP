import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AwsBulkLoader } from "../../../src/pricing/aws/bulk-loader.js";

// Always make fetch fail so the loader falls through to hardcoded fallback data.
// This keeps tests hermetic and fast (no real HTTP calls).
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-aws-test-${suffix}`, "cache.db");
}

describe("AwsBulkLoader", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // EC2 compute
  // -------------------------------------------------------------------------

  it("returns fallback price for t3.micro in us-east-1", async () => {
    const result = await loader.getComputePrice("t3.micro", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("ec2");
    expect(result!.resource_type).toBe("t3.micro");
    expect(result!.region).toBe("us-east-1");
    expect(result!.unit).toBe("Hrs");
    expect(result!.currency).toBe("USD");
    // Exact fallback price for t3.micro in us-east-1 (multiplier = 1.0)
    expect(result!.price_per_unit).toBeCloseTo(0.0104, 4);
  });

  it("applies regional multiplier for eu-west-1 (1.05x)", async () => {
    const usResult = await loader.getComputePrice("t3.large", "us-east-1");
    const euResult = await loader.getComputePrice("t3.large", "eu-west-1");

    expect(usResult).not.toBeNull();
    expect(euResult).not.toBeNull();

    const expectedEuPrice = 0.0832 * 1.05;
    expect(euResult!.price_per_unit).toBeCloseTo(expectedEuPrice, 4);
    expect(euResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
  });

  it("applies regional multiplier for ap-southeast-1 (1.10x)", async () => {
    const result = await loader.getComputePrice("m5.large", "ap-southeast-1");

    expect(result).not.toBeNull();
    const expectedPrice = 0.096 * 1.10;
    expect(result!.price_per_unit).toBeCloseTo(expectedPrice, 4);
  });

  it("returns null for an unknown instance type", async () => {
    const result = await loader.getComputePrice("t9000.giga", "us-east-1");
    expect(result).toBeNull();
  });

  it("returns correct prices for m5 and c5 series", async () => {
    const m5xl = await loader.getComputePrice("m5.xlarge", "us-east-1");
    const c5lg = await loader.getComputePrice("c5.large", "us-east-1");

    expect(m5xl!.price_per_unit).toBeCloseTo(0.192, 4);
    expect(c5lg!.price_per_unit).toBeCloseTo(0.085, 4);
  });

  it("stores result in cache so subsequent calls return from cache", async () => {
    await loader.getComputePrice("t3.medium", "us-east-1");

    const stats = cache.getStats();
    expect(stats.total_entries).toBeGreaterThan(0);

    // Second call should also succeed (served from cache)
    const second = await loader.getComputePrice("t3.medium", "us-east-1");
    expect(second).not.toBeNull();
    expect(second!.price_per_unit).toBeCloseTo(0.0416, 4);
  });

  // -------------------------------------------------------------------------
  // RDS database
  // -------------------------------------------------------------------------

  it("returns fallback price for db.t3.medium in us-east-1", async () => {
    const result = await loader.getDatabasePrice("db.t3.medium", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("rds");
    expect(result!.resource_type).toBe("db.t3.medium");
    expect(result!.price_per_unit).toBeCloseTo(0.068, 4);
    expect(result!.unit).toBe("Hrs");
  });

  it("returns fallback price for db.r5.large", async () => {
    const result = await loader.getDatabasePrice("db.r5.large", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.250, 4);
  });

  it("applies regional multiplier to RDS pricing", async () => {
    const usResult = await loader.getDatabasePrice("db.t3.micro", "us-east-1");
    const euResult = await loader.getDatabasePrice("db.t3.micro", "eu-west-1");

    expect(usResult).not.toBeNull();
    expect(euResult).not.toBeNull();
    expect(euResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
    expect(euResult!.price_per_unit).toBeCloseTo(0.017 * 1.05, 4);
  });

  it("returns null for unknown RDS instance class", async () => {
    const result = await loader.getDatabasePrice("db.z9.gigantic", "us-east-1");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // EBS storage
  // -------------------------------------------------------------------------

  it("returns fallback price for gp3 volume in us-east-1", async () => {
    const result = await loader.getStoragePrice("gp3", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("ebs");
    expect(result!.resource_type).toBe("gp3");
    expect(result!.unit).toBe("GB-Mo");
    expect(result!.price_per_unit).toBeCloseTo(0.08, 4);
  });

  it("returns fallback price for io2 volume", async () => {
    const result = await loader.getStoragePrice("io2", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.125, 4);
  });

  it("returns fallback price for st1 (cold HDD) volume", async () => {
    const result = await loader.getStoragePrice("st1", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.045, 4);
  });

  it("applies regional multiplier to EBS pricing", async () => {
    const usResult = await loader.getStoragePrice("gp3", "us-east-1");
    const apResult = await loader.getStoragePrice("gp3", "ap-southeast-1");

    expect(usResult).not.toBeNull();
    expect(apResult).not.toBeNull();
    expect(apResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
    expect(apResult!.price_per_unit).toBeCloseTo(0.08 * 1.10, 4);
  });

  it("returns null for unknown volume type", async () => {
    const result = await loader.getStoragePrice("quantum-ssd", "us-east-1");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // ALB / NAT / EKS
  // -------------------------------------------------------------------------

  it("returns ALB hourly price for us-east-1", async () => {
    const result = await loader.getLoadBalancerPrice("us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("elb");
    expect(result!.price_per_unit).toBeCloseTo(0.0225, 4);
  });

  it("returns NAT Gateway hourly price", async () => {
    const result = await loader.getNatGatewayPrice("us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("vpc");
    expect(result!.price_per_unit).toBeCloseTo(0.045, 4);
    expect(result!.attributes.per_gb_price).toBe("0.045");
  });

  it("returns EKS control plane price", async () => {
    const result = await loader.getKubernetesPrice("us-east-1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("aws");
    expect(result!.service).toBe("eks");
    expect(result!.price_per_unit).toBeCloseTo(0.10, 4);
  });

  // -------------------------------------------------------------------------
  // Cache interaction
  // -------------------------------------------------------------------------

  it("cache is populated after first fetch", async () => {
    const statsBefore = cache.getStats();
    expect(statsBefore.total_entries).toBe(0);

    await loader.getComputePrice("r5.large", "us-east-1");

    const statsAfter = cache.getStats();
    expect(statsAfter.total_entries).toBeGreaterThan(0);
  });

  it("repeated calls for same key do not grow the cache", async () => {
    await loader.getComputePrice("r5.xlarge", "us-east-1");
    const statsFirst = cache.getStats();

    await loader.getComputePrice("r5.xlarge", "us-east-1");
    const statsSecond = cache.getStats();

    expect(statsSecond.total_entries).toBe(statsFirst.total_entries);
  });
});
