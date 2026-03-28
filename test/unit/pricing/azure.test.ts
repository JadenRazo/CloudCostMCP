import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AzureRetailClient } from "../../../src/pricing/azure/retail-client.js";

// Always make fetch fail so the client falls through to hardcoded fallback data.
// This keeps tests hermetic and fast (no real HTTP calls).
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-azure-test-${suffix}`, "cache.db");
}

describe("AzureRetailClient", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // VM compute
  // -------------------------------------------------------------------------

  it("returns fallback price for Standard_B1s in eastus", async () => {
    const result = await client.getComputePrice("Standard_B1s", "eastus");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("virtual-machines");
    expect(result!.resource_type).toBe("Standard_B1s");
    expect(result!.region).toBe("eastus");
    expect(result!.currency).toBe("USD");
    // Exact fallback: 0.0104 * 1.0 multiplier
    expect(result!.price_per_unit).toBeCloseTo(0.0104, 4);
  });

  it("applies regional multiplier for northeurope (1.05x)", async () => {
    const usResult = await client.getComputePrice("Standard_B2s", "eastus");
    const euResult = await client.getComputePrice("Standard_B2s", "northeurope");

    expect(usResult).not.toBeNull();
    expect(euResult).not.toBeNull();
    expect(euResult!.price_per_unit).toBeCloseTo(0.0416 * 1.05, 4);
    expect(euResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
  });

  it("applies regional multiplier for southeastasia (1.08x)", async () => {
    const result = await client.getComputePrice("Standard_D2s_v5", "southeastasia");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.096 * 1.08, 4);
  });

  it("returns correct prices for D and F series VMs", async () => {
    const d4 = await client.getComputePrice("Standard_D4s_v5", "eastus");
    const f4 = await client.getComputePrice("Standard_F4s_v2", "eastus");

    expect(d4!.price_per_unit).toBeCloseTo(0.192, 4);
    expect(f4!.price_per_unit).toBeCloseTo(0.17, 4);
  });

  it("returns null for an unknown VM size", async () => {
    const result = await client.getComputePrice("Standard_X99999", "eastus");
    expect(result).toBeNull();
  });

  it("stores compute result in cache after first call", async () => {
    await client.getComputePrice("Standard_B4ms", "eastus");
    const stats = cache.getStats();
    expect(stats.total_entries).toBeGreaterThan(0);

    // Second call served from cache
    const second = await client.getComputePrice("Standard_B4ms", "eastus");
    expect(second).not.toBeNull();
    expect(second!.price_per_unit).toBeCloseTo(0.166, 4);
  });

  // -------------------------------------------------------------------------
  // Database pricing
  // -------------------------------------------------------------------------

  it("returns fallback price for GP_Standard_D2s_v3 PostgreSQL", async () => {
    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus", "PostgreSQL");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("azure-database");
    expect(result!.price_per_unit).toBeCloseTo(0.124, 4);
    expect(result!.unit).toBe("1 Hour");
  });

  it("applies regional multiplier to database pricing", async () => {
    const usResult = await client.getDatabasePrice("GP_Standard_D4s_v3", "eastus");
    const euResult = await client.getDatabasePrice("GP_Standard_D4s_v3", "northeurope");

    expect(usResult).not.toBeNull();
    expect(euResult).not.toBeNull();
    expect(euResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
    expect(euResult!.price_per_unit).toBeCloseTo(0.248 * 1.05, 4);
  });

  it("returns null for unknown database tier", async () => {
    const result = await client.getDatabasePrice("MegaTier_9000", "eastus");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Managed Disk / Storage pricing
  // -------------------------------------------------------------------------

  it("returns fallback price for Premium_LRS in eastus", async () => {
    const result = await client.getStoragePrice("Premium_LRS", "eastus");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("managed-disks");
    expect(result!.resource_type).toBe("Premium_LRS");
    expect(result!.price_per_unit).toBeCloseTo(0.132, 4);
  });

  it("returns fallback price for Standard_LRS", async () => {
    const result = await client.getStoragePrice("Standard_LRS", "eastus");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.04, 4);
  });

  it("applies regional multiplier to disk pricing", async () => {
    const usResult = await client.getStoragePrice("Premium_LRS", "eastus");
    const apResult = await client.getStoragePrice("Premium_LRS", "southeastasia");

    expect(usResult).not.toBeNull();
    expect(apResult).not.toBeNull();
    expect(apResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
    expect(apResult!.price_per_unit).toBeCloseTo(0.132 * 1.08, 4);
  });

  it("returns null for unknown disk type", async () => {
    const result = await client.getStoragePrice("QuantumDisk_LRS", "eastus");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Load Balancer / NAT / AKS
  // -------------------------------------------------------------------------

  it("returns Azure Load Balancer hourly price", async () => {
    const result = await client.getLoadBalancerPrice("eastus");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("load-balancer");
    expect(result!.price_per_unit).toBeCloseTo(0.025, 4);
    expect(result!.attributes.rule_hourly_price).toBe("0.005");
  });

  it("returns Azure NAT Gateway price", async () => {
    const result = await client.getNatGatewayPrice("eastus");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("nat-gateway");
    expect(result!.price_per_unit).toBeCloseTo(0.045, 4);
  });

  it("returns AKS control plane price", async () => {
    const result = await client.getKubernetesPrice("eastus");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("azure");
    expect(result!.service).toBe("aks");
    expect(result!.price_per_unit).toBeCloseTo(0.1, 4);
  });

  // -------------------------------------------------------------------------
  // Cache interaction
  // -------------------------------------------------------------------------

  it("cache is empty before any fetch", async () => {
    const stats = cache.getStats();
    expect(stats.total_entries).toBe(0);
  });

  it("repeated calls for same key do not grow the cache", async () => {
    await client.getComputePrice("Standard_E2s_v5", "eastus");
    const statsFirst = cache.getStats();

    await client.getComputePrice("Standard_E2s_v5", "eastus");
    const statsSecond = cache.getStats();

    expect(statsSecond.total_entries).toBe(statsFirst.total_entries);
  });
});
