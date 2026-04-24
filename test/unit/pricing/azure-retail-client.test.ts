import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AzureRetailClient, parseAzureVmSeries } from "../../../src/pricing/azure/retail-client.js";
import { resetAllCircuits } from "../../../src/pricing/fetch-utils.js";
import { tempDbPath } from "../../helpers/factories.js";
import { makeJsonResponse, makeErrorResponse } from "../../helpers/mock-fetch.js";
import type { AzureRetailPriceItem } from "../../../src/pricing/azure/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AzureRetailPriceItem> = {}): AzureRetailPriceItem {
  return {
    currencyCode: "USD",
    tierMinimumUnits: 0,
    retailPrice: 0.096,
    unitPrice: 0.096,
    armRegionName: "eastus",
    location: "US East",
    effectiveStartDate: "2026-01-01T00:00:00Z",
    meterId: "m-1",
    meterName: "D2s v5",
    productId: "p-1",
    skuId: "s-1",
    productName: "Virtual Machines Dsv5 Series",
    skuName: "D2s v5",
    serviceName: "Virtual Machines",
    serviceId: "svc-1",
    serviceFamily: "Compute",
    unitOfMeasure: "1 Hour",
    type: "Consumption",
    isPrimaryMeterRegion: true,
    armSkuName: "Standard_D2s_v5",
    ...overrides,
  };
}

/**
 * Stub fetch to return a single page containing the provided items.
 */
function stubSinglePage(items: AzureRetailPriceItem[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      makeJsonResponse({
        BillingCurrency: "USD",
        CustomerEntityId: "",
        CustomerEntityType: "",
        Items: items,
        NextPageLink: null,
        Count: items.length,
      }),
    ),
  );
}

/**
 * Stub fetch to return multiple pages in sequence — each call yields the
 * next page until we run out.
 */
function stubPaginated(pages: AzureRetailPriceItem[][]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async () => {
    const items = pages[i] ?? [];
    const hasNext = i < pages.length - 1;
    i++;
    return makeJsonResponse({
      BillingCurrency: "USD",
      CustomerEntityId: "",
      CustomerEntityType: "",
      Items: items,
      NextPageLink: hasNext ? `https://prices.azure.com/next-page-${i}` : null,
      Count: items.length,
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ---------------------------------------------------------------------------
// parseAzureVmSeries — unit tests for every documented SKU shape
// ---------------------------------------------------------------------------

describe("parseAzureVmSeries", () => {
  it.each([
    ["Standard_D2s_v5", { series: "Dsv5", vcpus: 2 }],
    ["Standard_D4s_v5", { series: "Dsv5", vcpus: 4 }],
    ["Standard_E4ds_v5", { series: "Edsv5", vcpus: 4 }],
    ["Standard_M64ms_v2", { series: "Mmsv2", vcpus: 64 }],
    ["Standard_DC4s_v3", { series: "DCsv3", vcpus: 4 }],
    ["Standard_E96ias_v5", { series: "Eiasv5", vcpus: 96 }],
    ["Standard_Eb8as_v5", { series: "Ebasv5", vcpus: 8 }],
  ])("parses %s as %o", (sku, expected) => {
    expect(parseAzureVmSeries(sku)).toEqual(expected);
  });

  it("parses a SKU with an accelerator segment (Standard_NC4as_T4_v3)", () => {
    const out = parseAzureVmSeries("Standard_NC4as_T4_v3");
    expect(out).not.toBeNull();
    expect(out!.vcpus).toBe(4);
    // The series string joins the extras into the suffix.
    expect(out!.series).toContain("T4");
  });

  it("returns null for a non-standard SKU", () => {
    expect(parseAzureVmSeries("custom_vm")).toBeNull();
    expect(parseAzureVmSeries("Standard_XYZ")).toBeNull();
    expect(parseAzureVmSeries("")).toBeNull();
  });

  it("returns null when vCPU count is zero", () => {
    expect(parseAzureVmSeries("Standard_D0s_v5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getComputePrice — live API
// ---------------------------------------------------------------------------

describe("AzureRetailClient.getComputePrice — live path", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-retail-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the live match when the Retail API surfaces it", async () => {
    stubSinglePage([makeItem({ retailPrice: 0.12 })]);

    const result = await client.getComputePrice("Standard_D2s_v5", "eastus");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.12, 4);
    expect(result!.attributes.pricing_source).toBe("live");
  });

  it("falls back to hardcoded pricing when the Retail API returns an empty page", async () => {
    stubSinglePage([]);

    const result = await client.getComputePrice("Standard_B1s", "eastus");

    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("prefers the matching OS variant when multiple items are returned", async () => {
    stubSinglePage([
      makeItem({
        skuName: "standard_d2s_v5 Windows",
        meterName: "D2s v5 Windows",
        retailPrice: 0.25,
        skuId: "sku-win",
      }),
      makeItem({
        skuName: "standard_d2s_v5",
        meterName: "D2s v5",
        retailPrice: 0.1,
        skuId: "sku-lin",
      }),
    ]);

    const lin = await client.getComputePrice("Standard_D2s_v5", "eastus", "linux");
    expect(lin!.price_per_unit).toBeCloseTo(0.1, 4);
  });

  it("returns a Windows match when OS=Windows is requested", async () => {
    // vmSize is lowercased then substring-matched, so put the vmSize
    // literally inside the skuName to trigger the prefer-exact branch.
    stubSinglePage([
      makeItem({
        skuName: "standard_d2s_v5",
        meterName: "D2s v5",
        retailPrice: 0.1,
        skuId: "sku-lin",
      }),
      makeItem({
        skuName: "standard_d2s_v5 Windows",
        meterName: "D2s v5 Windows",
        retailPrice: 0.25,
        skuId: "sku-win",
      }),
    ]);

    const win = await client.getComputePrice("Standard_D2s_v5", "eastus", "windows");
    expect(win!.price_per_unit).toBeCloseTo(0.25, 4);
  });

  it("falls back to the first sorted item when no OS match is found", async () => {
    // Neither item's skuName contains the vmSize substring — pickVmItem
    // drops into the "return sorted[0]" fallback.
    stubSinglePage([
      makeItem({
        skuName: "ZZ higher sku",
        retailPrice: 0.5,
        skuId: "sku-z",
      }),
      makeItem({
        skuName: "AA lower sku",
        retailPrice: 0.3,
        skuId: "sku-a",
      }),
    ]);

    const result = await client.getComputePrice("Standard_X_novm", "eastus");
    expect(result).not.toBeNull();
    // sku-a sorts first → retailPrice 0.3 picked.
    expect(result!.price_per_unit).toBeCloseTo(0.3, 4);
  });

  it("falls back to static pricing when Retail API returns a non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeErrorResponse(500)),
    );

    const result = await client.getComputePrice("Standard_B1s", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("falls back to static pricing when fetch rejects entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      }),
    );

    const result = await client.getComputePrice("Standard_B1s", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("paginates across multiple NextPageLink responses", async () => {
    // The matching item (skuName contains vmSize lowercased) lives on page 3;
    // pagination must collect all pages before pickVmItem picks the match.
    const fn = stubPaginated([
      [makeItem({ skuName: "AA", skuId: "a", retailPrice: 0.05 })],
      [makeItem({ skuName: "BB", skuId: "b", retailPrice: 0.06 })],
      [
        makeItem({
          skuName: "standard_d2s_v5 match",
          meterName: "D2s v5",
          skuId: "match",
          retailPrice: 0.1,
        }),
      ],
    ]);

    const result = await client.getComputePrice("Standard_D2s_v5", "eastus");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.1, 4);
  });

  it("stops after 10 pages even if NextPageLink keeps coming", async () => {
    // Sanity-check the `pages < 10` guard. We'd otherwise loop infinitely.
    let pages = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pages++;
        return makeJsonResponse({
          BillingCurrency: "USD",
          CustomerEntityId: "",
          CustomerEntityType: "",
          Items: [],
          NextPageLink: "https://prices.azure.com/next-forever",
          Count: 0,
        });
      }),
    );

    // Use a vmSize not in the fallback table to force the live path through.
    // The caller swallows any error and falls back; we care that fetch was
    // called at most 10 times regardless.
    await client.getComputePrice("Standard_B1s", "eastus");
    expect(pages).toBeLessThanOrEqual(10);
    expect(pages).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// getDatabasePrice
// ---------------------------------------------------------------------------

describe("AzureRetailClient.getDatabasePrice", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-retail-db-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns a direct armSkuName match when the API has one", async () => {
    // Approach 1: one entry whose armSkuName equals the stripped VM name
    // and whose meterName includes 'vcore'.
    stubSinglePage([
      makeItem({
        serviceName: "Azure Database for PostgreSQL",
        armSkuName: "Standard_D2s_v3",
        skuName: "D2s v3 vCore",
        meterName: "vCore D2s v3",
        retailPrice: 0.13,
        skuId: "sku-exact",
      }),
    ]);

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus", "PostgreSQL");

    expect(result).not.toBeNull();
    expect(result!.service).toBe("azure-database");
    expect(result!.price_per_unit).toBeCloseTo(0.13, 4);
  });

  it("prefers a non-vcore entry when no 'vcore' meterName exists", async () => {
    // Exact SKU match but meterName doesn't include 'vcore' — code uses
    // the first sorted item unchanged.
    stubSinglePage([
      makeItem({
        serviceName: "Azure Database for PostgreSQL",
        armSkuName: "Standard_D2s_v3",
        skuName: "D2s v3",
        meterName: "D2s v3",
        retailPrice: 0.17,
        skuId: "sku-first",
      }),
    ]);

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus");
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.17, 4);
  });

  it("falls back to per-vCore series lookup when no exact SKU match exists", async () => {
    // First query (exactFilter) returns nothing; second query (seriesFilter)
    // returns one item whose retailPrice is per-vCore. The DB approach 2
    // code multiplies by the vCPU count (2 for D2s_v3).
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return makeJsonResponse({
            BillingCurrency: "USD",
            CustomerEntityId: "",
            CustomerEntityType: "",
            Items: [],
            NextPageLink: null,
            Count: 0,
          });
        }
        return makeJsonResponse({
          BillingCurrency: "USD",
          CustomerEntityId: "",
          CustomerEntityType: "",
          Items: [
            makeItem({
              serviceName: "Azure Database for PostgreSQL",
              armSkuName: "General_Purpose_Dsv3_Compute",
              skuName: "General Purpose Dsv3 vCore",
              meterName: "vCore",
              retailPrice: 0.0685, // per-vCore
              skuId: "sku-percore",
            }),
          ],
          NextPageLink: null,
          Count: 1,
        });
      }),
    );

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus", "PostgreSQL");

    expect(result).not.toBeNull();
    // 0.0685 * 2 vCPUs ≈ 0.137
    expect(result!.price_per_unit).toBeCloseTo(0.137, 3);
  });

  it("returns null when the series approach finds nothing either", async () => {
    // Both queries empty → Approach 2 also fails → internal returns null,
    // caller falls back to static table.
    stubSinglePage([]);

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus", "PostgreSQL");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("returns null when VM name can't be parsed AND tier is not in the static table", async () => {
    // First call: empty exact match. Second call would be skipped because
    // parseVmSeries returns null for an unparseable name. Caller then falls
    // back; unknown tier → null.
    stubSinglePage([]);

    const result = await client.getDatabasePrice("GP_Standard_unparseable", "eastus");
    expect(result).toBeNull();
  });

  it("falls back successfully for a known GP_* tier in the static table", async () => {
    // "GP_Standard_D2s_v3" is in DB_BASE_PRICES; when the API returns nothing,
    // the fallback path should succeed.
    stubSinglePage([]);

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("uses Memory_Optimized series family when tier prefix is MO", async () => {
    let call = 0;
    const fn = vi.fn(async (url: string) => {
      call++;
      // Second call (series filter) should include 'Memory_Optimized'
      if (call === 2) {
        expect(url).toContain("Memory_Optimized");
      }
      return makeJsonResponse({
        BillingCurrency: "USD",
        CustomerEntityId: "",
        CustomerEntityType: "",
        Items: [],
        NextPageLink: null,
        Count: 0,
      });
    });
    vi.stubGlobal("fetch", fn);

    await client.getDatabasePrice("MO_Standard_E4ds_v5", "eastus", "PostgreSQL");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses General_Purpose series family for GP / BC / default prefixes", async () => {
    let call = 0;
    const seen: string[] = [];
    const fn = vi.fn(async (url: string) => {
      call++;
      if (call === 2) seen.push(url);
      return makeJsonResponse({
        BillingCurrency: "USD",
        CustomerEntityId: "",
        CustomerEntityType: "",
        Items: [],
        NextPageLink: null,
        Count: 0,
      });
    });
    vi.stubGlobal("fetch", fn);

    await client.getDatabasePrice("BC_Standard_D2s_v3", "eastus");
    // BC is NOT "MO", so the code uses General_Purpose.
    expect(seen[0]).toContain("General_Purpose");
  });

  it("falls back to static pricing when Retail API rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );

    const result = await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("returns null for unparseable tier that isn't in the static table", async () => {
    stubSinglePage([]);
    const result = await client.getDatabasePrice("gibberish_tier", "eastus");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getStoragePrice
// ---------------------------------------------------------------------------

describe("AzureRetailClient.getStoragePrice", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-retail-st-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns a live match when the API surfaces one", async () => {
    stubSinglePage([
      makeItem({
        serviceName: "Storage",
        skuName: "Premium LRS P10",
        meterName: "P10 LRS Disk",
        unitOfMeasure: "1/Month",
        retailPrice: 19.71,
        skuId: "sku-disk",
      }),
    ]);

    const result = await client.getStoragePrice("Premium_LRS", "eastus");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("managed-disks");
    expect(result!.price_per_unit).toBeCloseTo(19.71, 2);
  });

  it("falls back to static pricing when the API returns an empty page", async () => {
    stubSinglePage([]);

    const result = await client.getStoragePrice("Premium_LRS", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("falls back to static pricing when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await client.getStoragePrice("Premium_LRS", "eastus");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("returns null when the disk type is unknown to the static table", async () => {
    stubSinglePage([]);
    const result = await client.getStoragePrice("unobtanium_disk", "eastus");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getReservationHourlyRate — unit handling
// ---------------------------------------------------------------------------

describe("AzureRetailClient.getReservationHourlyRate", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-retail-ri-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when getReservationPrice has no matching term", async () => {
    // Empty page → getReservationPrice returns null → hourly is null.
    stubSinglePage([]);

    const rate = await client.getReservationHourlyRate("Standard_D2s_v5", "eastus", "1yr");
    expect(rate).toBeNull();
  });

  it("returns null when retailPrice is zero / non-finite", async () => {
    stubSinglePage([
      makeItem({
        retailPrice: 0,
        unitOfMeasure: "1 Hour",
        reservationTerm: "1 Year",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate("Standard_D2s_v5", "eastus", "1yr");
    expect(rate).toBeNull();
  });

  it("returns raw price when unit is 'hour' (already hourly)", async () => {
    stubSinglePage([
      makeItem({
        retailPrice: 0.065,
        unitOfMeasure: "1 Hour",
        reservationTerm: "1 Year",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate("Standard_D2s_v5", "eastus", "1yr");
    expect(rate).toBeCloseTo(0.065, 4);
  });

  it("divides annual upfront price by hours-in-3-years for 3yr term", async () => {
    // 3-year upfront: 1500 / (8760 * 3) ≈ 0.0571/hr
    stubSinglePage([
      makeItem({
        retailPrice: 1500,
        unitOfMeasure: "1/Years", // note: contains 'year'
        reservationTerm: "3 Years",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate("Standard_D2s_v5", "eastus", "3yr");
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(1500 / (8760 * 3), 5);
  });

  it("falls back to raw value for unknown units (safest guess)", async () => {
    stubSinglePage([
      makeItem({
        retailPrice: 0.08,
        unitOfMeasure: "per-weird-unit",
        reservationTerm: "1 Year",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate("Standard_D2s_v5", "eastus", "1yr");
    expect(rate).toBeCloseTo(0.08, 4);
  });
});

// ---------------------------------------------------------------------------
// Fixed-price services (ALB / NAT / AKS) — exercise regional multipliers
// ---------------------------------------------------------------------------

describe("AzureRetailClient — fixed-price services", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-fixed-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("applies region multiplier to load-balancer pricing", async () => {
    const us = await client.getLoadBalancerPrice("eastus");
    const eu = await client.getLoadBalancerPrice("northeurope");
    expect(us).not.toBeNull();
    expect(eu).not.toBeNull();
    expect(eu!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
    // rule_hourly_price attribute should also scale.
    expect(parseFloat(eu!.attributes.rule_hourly_price as string)).toBeGreaterThan(
      parseFloat(us!.attributes.rule_hourly_price as string),
    );
  });

  it("applies region multiplier to NAT gateway pricing", async () => {
    const us = await client.getNatGatewayPrice("eastus");
    const eu = await client.getNatGatewayPrice("northeurope");
    expect(us).not.toBeNull();
    expect(eu).not.toBeNull();
    expect(eu!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("applies region multiplier to AKS pricing", async () => {
    const us = await client.getKubernetesPrice("eastus");
    const ap = await client.getKubernetesPrice("southeastasia");
    expect(us).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour — second call short-circuits
// ---------------------------------------------------------------------------

describe("AzureRetailClient — cache hit short-circuit", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AzureRetailClient;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-azure-cache-test");
    cache = new PricingCache(dbPath);
    client = new AzureRetailClient(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("compute: second call does not refetch after a cache hit", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fn);

    await client.getComputePrice("Standard_B2s", "eastus");
    const firstCalls = fn.mock.calls.length;
    await client.getComputePrice("Standard_B2s", "eastus");
    expect(fn.mock.calls.length).toBe(firstCalls);
  });

  it("database: second call does not refetch after a cache hit", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fn);

    await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus");
    const firstCalls = fn.mock.calls.length;
    await client.getDatabasePrice("GP_Standard_D2s_v3", "eastus");
    expect(fn.mock.calls.length).toBe(firstCalls);
  });

  it("storage: second call does not refetch after a cache hit", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fn);

    await client.getStoragePrice("Premium_LRS", "eastus");
    const firstCalls = fn.mock.calls.length;
    await client.getStoragePrice("Premium_LRS", "eastus");
    expect(fn.mock.calls.length).toBe(firstCalls);
  });
});
