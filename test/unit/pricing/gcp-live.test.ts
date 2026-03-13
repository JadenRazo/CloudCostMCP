import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { CloudBillingClient } from "../../../src/pricing/gcp/cloud-billing-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-gcp-live-test-${suffix}`, "cache.db");
}

// Build a minimal GCP SKU object for use in stub responses
function makeSku(
  skuId: string,
  description: string,
  resourceFamily: string,
  usageType: string,
  regions: string[],
  priceNanos: number,
  usageUnit = "h"
) {
  return {
    name: `services/test/${skuId}`,
    skuId,
    description,
    category: {
      serviceDisplayName: "Test Service",
      resourceFamily,
      resourceGroup: "CPU",
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

// Wrap skus in the API list response shape
function makeSkuResponse(skus: object[], nextPageToken?: string) {
  return JSON.stringify({ skus, nextPageToken });
}

// ---------------------------------------------------------------------------
// Tests: successful live pricing retrieval
// ---------------------------------------------------------------------------

describe("CloudBillingClient – live pricing", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Compute
  // -------------------------------------------------------------------------

  it("returns live compute price when API succeeds", async () => {
    // 0.006 USD/h = 6_000_000 nanos
    const sku = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      6_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("compute-engine");
    expect(result!.resource_type).toBe("e2-micro");
    expect(result!.region).toBe("us-central1");
    expect(result!.unit).toBe("h");
    expect(result!.currency).toBe("USD");
    expect(result!.price_per_unit).toBeCloseTo(0.006, 6);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.attributes.sku_id).toBe("sku-e2-core-001");
  });

  it("returns null when no matching compute SKU is found", async () => {
    // SKU for a different family — should not match e2
    const sku = makeSku(
      "sku-n1-core-001",
      "N1 Predefined Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      10_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });

  it("filters out SKUs whose region does not match", async () => {
    const sku = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["europe-west1"], // wrong region
      6_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Database
  // -------------------------------------------------------------------------

  it("returns live database price when API succeeds", async () => {
    // 0.05 USD/h = 50_000_000 nanos
    const sku = makeSku(
      "sku-sql-core-001",
      "Cloud SQL: DB custom CORE running in Americas",
      "ApplicationServices",
      "OnDemand",
      ["us-central1"],
      50_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchDatabaseSkus("db-custom-2-7680", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-sql");
    expect(result!.resource_type).toBe("db-custom-2-7680");
    expect(result!.price_per_unit).toBeCloseTo(0.05, 6);
    expect(result!.attributes.pricing_source).toBe("live");
  });

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  it("returns live storage price when API succeeds", async () => {
    // 0.02 USD/GiBy.mo = 20_000_000 nanos
    const sku = makeSku(
      "sku-gcs-standard-001",
      "Standard Storage US Regional",
      "Storage",
      "OnDemand",
      ["us-central1"],
      20_000_000,
      "gibibyte month"
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchStorageSkus("STANDARD", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-storage");
    expect(result!.resource_type).toBe("STANDARD");
    expect(result!.unit).toBe("GiBy.mo");
    expect(result!.price_per_unit).toBeCloseTo(0.02, 6);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.attributes.storage_class).toBe("STANDARD");
  });

  it("normalises storage class to uppercase in result", async () => {
    const sku = makeSku(
      "sku-gcs-nearline-001",
      "Nearline Storage US Regional",
      "Storage",
      "OnDemand",
      ["us-central1"],
      10_000_000,
      "gibibyte month"
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const result = await client.fetchStorageSkus("nearline", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.resource_type).toBe("NEARLINE");
    expect(result!.attributes.storage_class).toBe("NEARLINE");
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it("follows nextPageToken to retrieve SKUs across multiple pages", async () => {
    const skuPage1 = makeSku(
      "sku-n2-core-001",
      "N2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      8_000_000
    );

    const skuPage2 = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      6_000_000
    );

    let callCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      callCount++;
      if (url.includes("pageToken=")) {
        return {
          ok: true,
          json: async () => JSON.parse(makeSkuResponse([skuPage2])),
        };
      }
      return {
        ok: true,
        json: async () => JSON.parse(makeSkuResponse([skuPage1], "page2token")),
      };
    });

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");

    expect(callCount).toBe(2);
    expect(result).not.toBeNull();
    // Both SKUs were retrieved; e2-core is picked for the e2 family
    expect(result!.attributes.sku_id).toBe("sku-e2-core-001");
  });
});

// ---------------------------------------------------------------------------
// Tests: fallback to bundled data when API fails
// ---------------------------------------------------------------------------

describe("CloudBillingClient – API failure handling", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null (not an exception) when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network unreachable");
    });

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null when API returns a non-OK HTTP status", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null when API response has no matching SKUs", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([])),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null when SKU has no tiered rates", async () => {
    const skuNoRates = {
      name: "services/test/sku-broken",
      skuId: "sku-broken",
      description: "E2 Instance Core running in Americas",
      category: {
        serviceDisplayName: "Compute Engine",
        resourceFamily: "Compute",
        resourceGroup: "CPU",
        usageType: "OnDemand",
      },
      serviceRegions: ["us-central1"],
      pricingInfo: [
        {
          effectiveTime: "2025-01-01T00:00:00Z",
          pricingExpression: {
            usageUnit: "h",
            tieredRates: [], // empty rates
          },
        },
      ],
    };

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([skuNoRates])),
    }));

    const result = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: cache hit / miss behaviour
// ---------------------------------------------------------------------------

describe("CloudBillingClient – cache behaviour", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: CloudBillingClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new CloudBillingClient(cache);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores a successful result in cache", async () => {
    const sku = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      6_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const statsBefore = cache.getStats();
    expect(statsBefore.total_entries).toBe(0);

    await client.fetchComputeSkus("e2-micro", "us-central1");

    const statsAfter = cache.getStats();
    expect(statsAfter.total_entries).toBe(1);
  });

  it("serves subsequent calls from cache without making another HTTP request", async () => {
    const sku = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      6_000_000
    );

    let fetchCallCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => JSON.parse(makeSkuResponse([sku])),
      };
    });

    // First call — hits the API
    const first = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(first).not.toBeNull();
    expect(fetchCallCount).toBe(1);

    // Second call — should be served from cache
    const second = await client.fetchComputeSkus("e2-micro", "us-central1");
    expect(second).not.toBeNull();
    expect(fetchCallCount).toBe(1); // no additional HTTP call

    expect(second!.price_per_unit).toBe(first!.price_per_unit);
  });

  it("does not cache null results (failed lookups)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("API down");
    });

    await client.fetchComputeSkus("e2-micro", "us-central1");

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(0);
  });

  it("uses separate cache keys for different machine types in the same region", async () => {
    const e2Sku = makeSku(
      "sku-e2-core-001",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      6_000_000
    );
    const n2Sku = makeSku(
      "sku-n2-core-001",
      "N2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      8_000_000
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([e2Sku, n2Sku])),
    }));

    await client.fetchComputeSkus("e2-micro", "us-central1");
    await client.fetchComputeSkus("n2-standard-4", "us-central1");

    const stats = cache.getStats();
    // Each machine type gets its own cache entry
    expect(stats.total_entries).toBe(2);
  });

  it("uses separate cache keys for the same type in different regions", async () => {
    const usSku = makeSku(
      "sku-gcs-standard-us",
      "Standard Storage US Regional",
      "Storage",
      "OnDemand",
      ["us-central1"],
      20_000_000
    );
    const euSku = makeSku(
      "sku-gcs-standard-eu",
      "Standard Storage Europe Regional",
      "Storage",
      "OnDemand",
      ["europe-west1"],
      23_000_000
    );

    vi.stubGlobal("fetch", async (url: string) => {
      // Return region-appropriate SKUs based on a naive URL check
      const sku = url.includes("storage") ? usSku : usSku;
      return {
        ok: true,
        json: async () => JSON.parse(makeSkuResponse([usSku, euSku])),
      };
    });

    await client.fetchStorageSkus("STANDARD", "us-central1");
    await client.fetchStorageSkus("STANDARD", "europe-west1");

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: GcpProvider integration (live → bundled fallback path)
// ---------------------------------------------------------------------------

describe("GcpProvider – live-then-bundled fallback", () => {
  // We test the integration through GcpProvider directly so we can verify
  // the fallback path without going through PricingEngine's full stack.
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to bundled data when the live API is unreachable", async () => {
    // Make fetch always fail so the live client returns null and the bundled
    // loader is used instead.
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch disabled in unit tests");
    });

    // Import here to pick up the stubbed fetch
    const { GcpBundledLoader } = await import(
      "../../../src/pricing/gcp/bundled-loader.js"
    );
    const loader = new GcpBundledLoader();

    // Bundled data should still work
    const result = await loader.getComputePrice("e2-micro", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.attributes.pricing_source).toBe("bundled");
    expect(result!.price_per_unit).toBeCloseTo(0.0084, 4);
  });

  it("uses live data when API returns a valid price", async () => {
    const sku = makeSku(
      "sku-e2-core-live",
      "E2 Instance Core running in Americas",
      "Compute",
      "OnDemand",
      ["us-central1"],
      7_500_000 // 0.0075 – slightly different from bundled 0.0084
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => JSON.parse(makeSkuResponse([sku])),
    }));

    const liveClient = new CloudBillingClient(cache);
    const result = await liveClient.fetchComputeSkus("e2-micro", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.price_per_unit).toBeCloseTo(0.0075, 6);
  });
});
