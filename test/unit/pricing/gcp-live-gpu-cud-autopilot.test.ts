import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { CloudBillingClient } from "../../../src/pricing/gcp/cloud-billing-client.js";
import {
  calculateGcpReservedPricingLive,
  clearLiveGcpCudRates,
  getLiveGcpCudRates,
} from "../../../src/calculator/reserved.js";
import { tempDbPath } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// Helpers — GPU SKUs, CUD rates, and Autopilot pod pricing
// ---------------------------------------------------------------------------

function makeSku(
  skuId: string,
  description: string,
  resourceFamily: string,
  resourceGroup: string,
  usageType: string,
  regions: string[],
  priceNanos: number,
  usageUnit = "h",
) {
  return {
    name: `services/test/${skuId}`,
    skuId,
    description,
    category: {
      serviceDisplayName: "Test Service",
      resourceFamily,
      resourceGroup,
      usageType,
    },
    serviceRegions: regions,
    pricingInfo: [
      {
        effectiveTime: "2025-01-01T00:00:00Z",
        pricingExpression: {
          usageUnit,
          displayQuantity: 1,
          tieredRates: [
            {
              startUsageAmount: 0,
              unitPrice: {
                currencyCode: "USD",
                units: "0",
                nanos: priceNanos,
              },
            },
          ],
        },
      },
    ],
  };
}

function makeResponse(skus: object[], nextPageToken?: string) {
  return JSON.stringify({ skus, nextPageToken });
}

// ---------------------------------------------------------------------------
// GPU SKU fetching
// ---------------------------------------------------------------------------

describe("CloudBillingClient.fetchGpuSkus", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-gcp-live-ext-test");
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the hourly price for a matching GPU SKU", async () => {
    // 0.35 USD/h = 350_000_000 nanos
    const sku = makeSku(
      "sku-gpu-t4-001",
      "Nvidia Tesla T4 GPU running in Americas",
      "Compute",
      "GPU",
      "OnDemand",
      ["us-central1"],
      350_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([sku])),
    }));

    const result = await client.fetchGpuSkus("nvidia-tesla-t4", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("compute-engine");
    expect(result!.resource_type).toBe("nvidia-tesla-t4");
    expect(result!.price_per_unit).toBeCloseTo(0.35, 6);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.attributes.accelerator).toBe("nvidia-tesla-t4");
  });

  it("matches multi-token accelerator names like nvidia-a100-80gb", async () => {
    const sku = makeSku(
      "sku-gpu-a100-80gb-001",
      "Nvidia A100 80GB GPU running in Americas",
      "Compute",
      "GPU",
      "OnDemand",
      ["us-central1"],
      3_670_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([sku])),
    }));

    const result = await client.fetchGpuSkus("nvidia-a100-80gb", "us-central1");
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(3.67, 4);
  });

  it("returns null when no GPU SKU matches the accelerator", async () => {
    const sku = makeSku(
      "sku-gpu-v100-001",
      "Nvidia Tesla V100 GPU running in Americas",
      "Compute",
      "GPU",
      "OnDemand",
      ["us-central1"],
      2_480_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([sku])),
    }));

    const result = await client.fetchGpuSkus("nvidia-tesla-t4", "us-central1");
    expect(result).toBeNull();
  });

  it("does not match non-GPU SKUs even when description contains the name", async () => {
    const sku = makeSku(
      "sku-misc-t4",
      "T4 storage auxiliary line-item",
      "Compute",
      "CPU", // wrong resource group
      "OnDemand",
      ["us-central1"],
      1_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([sku])),
    }));

    const result = await client.fetchGpuSkus("nvidia-tesla-t4", "us-central1");
    expect(result).toBeNull();
  });

  it("caches a successful GPU lookup", async () => {
    const sku = makeSku(
      "sku-gpu-t4-001",
      "Nvidia Tesla T4 GPU running in Americas",
      "Compute",
      "GPU",
      "OnDemand",
      ["us-central1"],
      350_000_000,
    );

    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return { ok: true, json: async () => JSON.parse(makeResponse([sku])) };
    });

    const first = await client.fetchGpuSkus("nvidia-tesla-t4", "us-central1");
    const second = await client.fetchGpuSkus("nvidia-tesla-t4", "us-central1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(fetchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CUD rate fetching
// ---------------------------------------------------------------------------

describe("CloudBillingClient.fetchCudRates", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-gcp-live-ext-test");
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes average discount fractions from OnDemand vs Commit SKUs", async () => {
    // OnDemand core @ 0.02, Commit1Yr core @ 0.014 (30% off), Commit3Yr core @ 0.009 (55% off)
    const onDemand = makeSku(
      "sku-n1-core-ondemand",
      "N1 Predefined Instance Core running in Americas",
      "Compute",
      "N1Standard",
      "OnDemand",
      ["us-central1"],
      20_000_000,
    );
    const commit1 = makeSku(
      "sku-n1-core-commit1yr",
      "Commitment v1: N1 Predefined Instance Core in Americas",
      "Compute",
      "N1Standard",
      "Commit1Yr",
      ["us-central1"],
      14_000_000,
    );
    const commit3 = makeSku(
      "sku-n1-core-commit3yr",
      "Commitment v1: N1 Predefined Instance Core in Americas for 3 Year",
      "Compute",
      "N1Standard",
      "Commit3Yr",
      ["us-central1"],
      9_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([onDemand, commit1, commit3])),
    }));

    const rates = await client.fetchCudRates("us-central1");

    expect(rates).not.toBeNull();
    expect(rates!.term1yr).toBeCloseTo(0.3, 2);
    expect(rates!.term3yr).toBeCloseTo(0.55, 2);
    expect(rates!.sample_count).toBeGreaterThan(0);
  });

  it("returns null when no matching Commit SKUs are found", async () => {
    const onDemand = makeSku(
      "sku-n1-core-ondemand",
      "N1 Predefined Instance Core running in Americas",
      "Compute",
      "N1Standard",
      "OnDemand",
      ["us-central1"],
      20_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([onDemand])),
    }));

    const rates = await client.fetchCudRates("us-central1");
    expect(rates).toBeNull();
  });

  it("returns null when API call fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const rates = await client.fetchCudRates("us-central1");
    expect(rates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Autopilot pod rate fetching
// ---------------------------------------------------------------------------

describe("CloudBillingClient.fetchAutopilotPodRates", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-gcp-live-ext-test");
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns vCPU, memory, and ephemeral storage rates from Autopilot SKUs", async () => {
    const vcpu = makeSku(
      "sku-autopilot-cpu",
      "Autopilot Pod CPU Requests (on-demand)",
      "Compute",
      "CPU",
      "OnDemand",
      ["us-central1"],
      57_700_000, // 0.0577/vCPU/hr
    );
    const memory = makeSku(
      "sku-autopilot-memory",
      "Autopilot Pod Memory Requests",
      "Compute",
      "RAM",
      "OnDemand",
      ["us-central1"],
      6_340_000, // 0.00634/GB/hr
      "gibibyte hour",
    );
    const storage = makeSku(
      "sku-autopilot-storage",
      "Autopilot Pod Ephemeral Storage Requests",
      "Storage",
      "SSD",
      "OnDemand",
      ["us-central1"],
      440_000, // 0.00044/GB/hr
      "gibibyte hour",
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([vcpu, memory, storage])),
    }));

    const result = await client.fetchAutopilotPodRates("us-central1");

    expect(result).not.toBeNull();
    expect(result!.service).toBe("gke");
    expect(result!.resource_type).toBe("autopilot-pod");
    expect(result!.price_per_unit).toBeCloseTo(0.0577, 4);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.attributes.mode).toBe("autopilot");
    expect(result!.attributes.pricing_model).toBe("per_pod_resource");
    expect(result!.attributes.vcpu_hourly).toBeDefined();
    expect(parseFloat(result!.attributes.memory_gb_hourly!)).toBeCloseTo(0.00634, 5);
    expect(parseFloat(result!.attributes.ephemeral_storage_gb_hourly!)).toBeCloseTo(0.00044, 5);
  });

  it("returns null when no Autopilot vCPU SKU is found", async () => {
    const unrelated = makeSku(
      "sku-standard-cluster",
      "GKE Standard Cluster Management Fee",
      "ApplicationServices",
      "GKE",
      "OnDemand",
      ["us-central1"],
      100_000_000,
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeResponse([unrelated])),
    }));

    const result = await client.fetchAutopilotPodRates("us-central1");
    expect(result).toBeNull();
  });

  it("returns null when API call fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("GKE service unreachable");
    });

    const result = await client.fetchAutopilotPodRates("us-central1");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// calculateGcpReservedPricingLive integration with the CUD client
// ---------------------------------------------------------------------------

describe("calculateGcpReservedPricingLive", () => {
  beforeEach(() => {
    clearLiveGcpCudRates();
  });

  afterEach(() => {
    clearLiveGcpCudRates();
    vi.restoreAllMocks();
  });

  it("uses live rates when the client returns them and marks source=live", async () => {
    const client = {
      fetchCudRates: vi.fn(async () => ({
        term1yr: 0.32,
        term3yr: 0.58,
        sample_count: 4,
      })),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(client.fetchCudRates).toHaveBeenCalledWith("us-central1");
    expect(result.source).toBe("live");

    const oneYr = result.options.find((o) => o.term === "1yr");
    const threeYr = result.options.find((o) => o.term === "3yr");
    expect(oneYr!.percentage_savings).toBeCloseTo(32, 0);
    expect(threeYr!.percentage_savings).toBeCloseTo(58, 0);

    // Subsequent sync callers for the same region pick up the cached rates.
    const cached = getLiveGcpCudRates("us-central1");
    expect(cached).toEqual({ term1yr: 0.32, term3yr: 0.58 });
  });

  it("falls back to the static table when the client returns null", async () => {
    const client = {
      fetchCudRates: vi.fn(async () => null),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);

    expect(result.source).toBe("fallback");
    // Static GCP 3yr all_upfront rate is 0.55 — ensure that's still what we got.
    const threeYrAll = result.options.find((o) => o.term === "3yr" && o.payment === "all_upfront");
    expect(threeYrAll!.percentage_savings).toBeCloseTo(55, 0);
  });

  it("falls back to the static table when the client throws", async () => {
    const client = {
      fetchCudRates: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await calculateGcpReservedPricingLive(100, "us-central1", client);
    expect(result.source).toBe("fallback");
  });
});
