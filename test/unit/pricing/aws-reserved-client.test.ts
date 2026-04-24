import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import {
  AwsReservedClient,
  extractRiRatesFromBulk,
} from "../../../src/pricing/aws/reserved-client.js";
import type { AwsBulkPricingResponse } from "../../../src/pricing/aws/types.js";

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-aws-ri-test-${suffix}`, "cache.db");
}

/**
 * Build a minimal AwsBulkPricingResponse matching the shape of the real
 * bulk-pricing JSON. The sample SKU is a t3.large with:
 *   - On-demand: $0.10/hr
 *   - RI 1yr no-upfront:     $0.065/hr  → 35% savings
 *   - RI 1yr all-upfront:    $512.40 upfront → effective $0.0585/hr → ~41.5%
 *   - RI 3yr no-upfront:     $0.045/hr  → 55% savings
 */
function buildBulk(): AwsBulkPricingResponse {
  const sku = "ABCD1234";
  return {
    formatVersion: "v1.0",
    disclaimer: "test",
    offerCode: "AmazonEC2",
    version: "test",
    publicationDate: "2026-04-01T00:00:00Z",
    products: {
      [sku]: {
        sku,
        productFamily: "Compute Instance",
        attributes: {
          instanceType: "t3.large",
          operatingSystem: "Linux",
          tenancy: "Shared",
          capacitystatus: "Used",
        },
      },
    },
    terms: {
      OnDemand: {
        [sku]: {
          OD1: {
            offerTermCode: "JRTCKXETXF",
            sku,
            effectiveDate: "2026-04-01T00:00:00Z",
            priceDimensions: {
              d1: {
                rateCode: `${sku}.JRTCKXETXF.6YS6EN2CT7`,
                description: "$0.10 per On Demand Linux t3.large Instance Hour",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: "0.1000000000" },
                appliesTo: [],
              },
            },
            termAttributes: {},
          },
        },
      },
      Reserved: {
        [sku]: {
          RI1yrNU: {
            offerTermCode: "4NA7Y494AB",
            sku,
            effectiveDate: "2026-04-01T00:00:00Z",
            priceDimensions: {
              d1: {
                rateCode: "r1",
                description: "1yr no-upfront hourly",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: "0.0650000000" },
                appliesTo: [],
              },
            },
            termAttributes: {
              LeaseContractLength: "1yr",
              PurchaseOption: "No Upfront",
              OfferingClass: "standard",
            },
          },
          RI1yrAU: {
            offerTermCode: "6QCMYABX3D",
            sku,
            effectiveDate: "2026-04-01T00:00:00Z",
            priceDimensions: {
              d1: {
                rateCode: "r2",
                description: "1yr all-upfront fee",
                beginRange: "0",
                endRange: "Inf",
                unit: "Quantity",
                pricePerUnit: { USD: "512.4000000000" },
                appliesTo: [],
              },
              d2: {
                rateCode: "r3",
                description: "1yr all-upfront hourly",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: "0.0000000000" },
                appliesTo: [],
              },
            },
            termAttributes: {
              LeaseContractLength: "1yr",
              PurchaseOption: "All Upfront",
              OfferingClass: "standard",
            },
          },
          RI3yrNU: {
            offerTermCode: "BPH9UHTB63",
            sku,
            effectiveDate: "2026-04-01T00:00:00Z",
            priceDimensions: {
              d1: {
                rateCode: "r4",
                description: "3yr no-upfront hourly",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: "0.0450000000" },
                appliesTo: [],
              },
            },
            termAttributes: {
              LeaseContractLength: "3yr",
              PurchaseOption: "No Upfront",
              OfferingClass: "standard",
            },
          },
        },
      },
    },
  };
}

describe("extractRiRatesFromBulk", () => {
  it("computes discount rates from on-demand and reserved terms", () => {
    const rates = extractRiRatesFromBulk(buildBulk(), "t3.large", "Linux");

    const oneYrNu = rates.find((r) => r.term === "1yr" && r.payment === "no_upfront");
    expect(oneYrNu).toBeDefined();
    // 0.065 / 0.10 = 0.65 → 35% savings
    expect(oneYrNu!.rate).toBeCloseTo(0.35, 3);

    const oneYrAu = rates.find((r) => r.term === "1yr" && r.payment === "all_upfront");
    expect(oneYrAu).toBeDefined();
    // 512.40 / (24*365) ≈ 0.05849 effective hourly → ~41.5% savings
    expect(oneYrAu!.rate).toBeCloseTo(0.4151, 2);

    const threeYrNu = rates.find((r) => r.term === "3yr" && r.payment === "no_upfront");
    expect(threeYrNu).toBeDefined();
    expect(threeYrNu!.rate).toBeCloseTo(0.55, 3);
  });

  it("returns empty array when no matching SKU exists", () => {
    const rates = extractRiRatesFromBulk(buildBulk(), "c9.mega", "Linux");
    expect(rates).toEqual([]);
  });

  it("skips bogus rates outside the plausible discount range", () => {
    const bulk = buildBulk();
    // Inject an absurdly cheap offer that would compute to >90% savings.
    bulk.terms.Reserved!["ABCD1234"]!["bogus"] = {
      offerTermCode: "Z",
      sku: "ABCD1234",
      effectiveDate: "2026-04-01T00:00:00Z",
      priceDimensions: {
        d1: {
          rateCode: "z",
          description: "bogus hourly",
          beginRange: "0",
          endRange: "Inf",
          unit: "Hrs",
          pricePerUnit: { USD: "0.0000100000" },
          appliesTo: [],
        },
      },
      termAttributes: { LeaseContractLength: "1yr", PurchaseOption: "No Upfront" },
    };

    const rates = extractRiRatesFromBulk(bulk, "t3.large", "Linux");
    // Only the legitimate rates survive (3 total).
    expect(rates.length).toBe(3);
  });
});

describe("AwsReservedClient", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AwsReservedClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new AwsReservedClient(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it("fetches bulk pricing and returns extracted rates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => buildBulk(),
      })),
    );

    const rates = await client.getRiRates("AmazonRDS", "t3.large", "us-east-1", "Linux");
    expect(rates).not.toBeNull();
    expect(rates!.length).toBeGreaterThan(0);
  });

  it("returns null on fetch failure (caller falls back to static table)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );

    const rates = await client.getRiRates("AmazonRDS", "t3.large", "us-east-1", "Linux");
    expect(rates).toBeNull();
  });

  it("returns null when extractor finds no matching SKU", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => buildBulk(),
      })),
    );

    const rates = await client.getRiRates("AmazonRDS", "nonexistent.huge", "us-east-1", "Linux");
    expect(rates).toBeNull();
  });

  it("caches rates so a second call doesn't refetch", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => buildBulk(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await client.getRiRates("AmazonRDS", "t3.large", "us-east-1", "Linux");
    await client.getRiRates("AmazonRDS", "t3.large", "us-east-1", "Linux");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses AmazonEC2 outright without performing a fetch", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => buildBulk(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    // Cast through unknown so the test can exercise the runtime guard even
    // though "AmazonEC2" is no longer part of the static type union.
    const rates = await client.getRiRates(
      "AmazonEC2" as unknown as "AmazonRDS",
      "t3.large",
      "us-east-1",
      "Linux",
    );
    expect(rates).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed region without calling fetch (URL-injection defense)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.getRiRates("AmazonRDS", "t3.large", "../../evil", "Linux")).rejects.toThrow(
      /invalid AWS region/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects service not in the allowlist without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.getRiRates(
        "AmazonFakeService" as unknown as "AmazonRDS",
        "t3.large",
        "us-east-1",
        "Linux",
      ),
    ).rejects.toThrow(/invalid AWS pricing service/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects region with path-traversal / query characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["us-east-1/../etc", "us-east-1?x=1", "us-east-1#frag", ""]) {
      await expect(client.getRiRates("AmazonRDS", "t3.large", bad, "Linux")).rejects.toThrow(
        /invalid AWS region/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
