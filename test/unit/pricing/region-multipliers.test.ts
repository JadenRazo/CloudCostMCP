import { describe, it, expect, beforeEach } from "vitest";
import {
  getRegionPriceMultipliers,
  _resetLoaderCache,
} from "../../../src/data/loader.js";

// Reset singleton cache before each test for isolation
beforeEach(() => {
  _resetLoaderCache();
});

describe("region-price-multipliers.json", () => {
  it("loads without error and returns an object with aws, azure, gcp keys", () => {
    const data = getRegionPriceMultipliers();
    expect(typeof data).toBe("object");
    expect(typeof data.aws).toBe("object");
    expect(typeof data.azure).toBe("object");
    expect(typeof data.gcp).toBe("object");
  });

  it("returns the same reference on repeated calls (lazy singleton)", () => {
    const first = getRegionPriceMultipliers();
    const second = getRegionPriceMultipliers();
    expect(first).toBe(second);
  });

  it("US baseline regions have a multiplier of 1.0 for all providers", () => {
    const { aws, azure, gcp } = getRegionPriceMultipliers();
    expect(aws["us-east-1"]).toBe(1.0);
    expect(aws["us-east-2"]).toBe(1.0);
    expect(aws["us-west-2"]).toBe(1.0);
    expect(azure["eastus"]).toBe(1.0);
    expect(azure["eastus2"]).toBe(1.0);
    expect(gcp["us-central1"]).toBe(1.0);
    expect(gcp["us-east1"]).toBe(1.0);
  });

  it("non-US regions have a multiplier greater than 1.0 for AWS", () => {
    const { aws } = getRegionPriceMultipliers();
    expect(aws["eu-west-1"]).toBeGreaterThan(1.0);
    expect(aws["eu-central-1"]).toBeGreaterThan(1.0);
    expect(aws["ap-southeast-1"]).toBeGreaterThan(1.0);
    expect(aws["ap-northeast-1"]).toBeGreaterThan(1.0);
    expect(aws["sa-east-1"]).toBeGreaterThan(1.0);
  });

  it("non-US regions have a multiplier greater than 1.0 for Azure", () => {
    const { azure } = getRegionPriceMultipliers();
    expect(azure["westeurope"]).toBeGreaterThan(1.0);
    expect(azure["northeurope"]).toBeGreaterThan(1.0);
    expect(azure["southeastasia"]).toBeGreaterThan(1.0);
    expect(azure["brazilsouth"]).toBeGreaterThan(1.0);
  });

  it("non-US regions have a multiplier greater than 1.0 for GCP", () => {
    const { gcp } = getRegionPriceMultipliers();
    expect(gcp["europe-west1"]).toBeGreaterThan(1.0);
    expect(gcp["asia-southeast1"]).toBeGreaterThan(1.0);
    expect(gcp["asia-northeast1"]).toBeGreaterThan(1.0);
    expect(gcp["southamerica-east1"]).toBeGreaterThan(1.0);
  });

  it("all multiplier values are numbers between 0.5 and 2.0 (sanity check)", () => {
    const { aws, azure, gcp } = getRegionPriceMultipliers();
    for (const [, val] of Object.entries(aws)) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0.5);
      expect(val).toBeLessThanOrEqual(2.0);
    }
    for (const [, val] of Object.entries(azure)) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0.5);
      expect(val).toBeLessThanOrEqual(2.0);
    }
    for (const [, val] of Object.entries(gcp)) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0.5);
      expect(val).toBeLessThanOrEqual(2.0);
    }
  });
});

// ---------------------------------------------------------------------------
// AWS fallback pricing – non-US vs US region comparisons
// ---------------------------------------------------------------------------

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AwsBulkLoader } from "../../../src/pricing/aws/bulk-loader.js";

// Disable live API calls
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-region-test-${suffix}`, "cache.db");
}

describe("AwsBulkLoader – fallback regional variance", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    _resetLoaderCache();
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
  });

  afterEach(() => {
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ap-southeast-1 compute price is higher than us-east-1", async () => {
    const us = await loader.getComputePrice("m5.large", "us-east-1");
    const ap = await loader.getComputePrice("m5.large", "ap-southeast-1");
    expect(us).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("sa-east-1 has the highest multiplier among checked AWS regions", async () => {
    const us = await loader.getComputePrice("t3.medium", "us-east-1");
    const sa = await loader.getComputePrice("t3.medium", "sa-east-1");
    const eu = await loader.getComputePrice("t3.medium", "eu-west-1");
    expect(sa!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
    expect(sa!.price_per_unit).toBeGreaterThan(eu!.price_per_unit);
  });

  it("unknown region falls back to 1.0 multiplier (same as us-east-1)", async () => {
    const us = await loader.getComputePrice("t3.micro", "us-east-1");
    const unknown = await loader.getComputePrice("t3.micro", "xx-nowhere-99");
    expect(us).not.toBeNull();
    expect(unknown).not.toBeNull();
    expect(unknown!.price_per_unit).toBeCloseTo(us!.price_per_unit, 6);
  });
});

// ---------------------------------------------------------------------------
// Azure fallback pricing – non-US vs US region comparisons
// ---------------------------------------------------------------------------

import { AzureRetailClient } from "../../../src/pricing/azure/retail-client.js";

describe("AzureRetailClient – fallback regional variance", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    _resetLoaderCache();
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
  });

  afterEach(() => {
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("westeurope compute price is higher than eastus", async () => {
    const us = await client.getComputePrice("Standard_D2s_v5", "eastus");
    const eu = await client.getComputePrice("Standard_D2s_v5", "westeurope");
    expect(us).not.toBeNull();
    expect(eu).not.toBeNull();
    expect(eu!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("brazilsouth has the highest multiplier among checked Azure regions", async () => {
    const us = await client.getComputePrice("Standard_B2s", "eastus");
    const br = await client.getComputePrice("Standard_B2s", "brazilsouth");
    const eu = await client.getComputePrice("Standard_B2s", "westeurope");
    expect(br!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
    expect(br!.price_per_unit).toBeGreaterThan(eu!.price_per_unit);
  });

  it("unknown region falls back to 1.0 multiplier (same as eastus)", async () => {
    const us = await client.getComputePrice("Standard_B1s", "eastus");
    const unknown = await client.getComputePrice("Standard_B1s", "xx-nowhere-99");
    expect(us).not.toBeNull();
    expect(unknown).not.toBeNull();
    expect(unknown!.price_per_unit).toBeCloseTo(us!.price_per_unit, 6);
  });
});

// ---------------------------------------------------------------------------
// GCP infrastructure pricing – non-US vs US region comparisons
// ---------------------------------------------------------------------------

import { GcpBundledLoader } from "../../../src/pricing/gcp/bundled-loader.js";

describe("GcpBundledLoader – infrastructure service regional variance", () => {
  const loader = new GcpBundledLoader();

  beforeEach(() => {
    _resetLoaderCache();
  });

  it("asia-northeast1 LB price is higher than us-central1", async () => {
    const us = await loader.getLoadBalancerPrice("us-central1");
    const ap = await loader.getLoadBalancerPrice("asia-northeast1");
    expect(us).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("southamerica-east1 NAT price is higher than us-central1", async () => {
    const us = await loader.getNatGatewayPrice("us-central1");
    const sa = await loader.getNatGatewayPrice("southamerica-east1");
    expect(us).not.toBeNull();
    expect(sa).not.toBeNull();
    expect(sa!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("asia-northeast1 GKE price is higher than us-central1", async () => {
    const us = await loader.getKubernetesPrice("us-central1", "standard");
    const ap = await loader.getKubernetesPrice("asia-northeast1", "standard");
    expect(us).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("unknown region defaults to 1.0 multiplier (same as us-central1)", async () => {
    const us = await loader.getLoadBalancerPrice("us-central1");
    const unknown = await loader.getLoadBalancerPrice("xx-nowhere-99");
    expect(us).not.toBeNull();
    expect(unknown).not.toBeNull();
    expect(unknown!.price_per_unit).toBeCloseTo(us!.price_per_unit, 6);
  });

  it("us-central1 GKE price is unchanged (multiplier = 1.0)", async () => {
    const result = await loader.getKubernetesPrice("us-central1", "standard");
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.10, 4);
  });
});
