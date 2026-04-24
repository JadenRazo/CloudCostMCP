import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AwsBulkLoader } from "../../../src/pricing/aws/bulk-loader.js";
import { resetAllCircuits } from "../../../src/pricing/fetch-utils.js";
import { tempDbPath } from "../../helpers/factories.js";
import {
  makeStreamingTextResponse,
  makeMultiChunkResponse,
  makeJsonResponse,
  makeErrorResponse,
} from "../../helpers/mock-fetch.js";
import type { AwsBulkPricingResponse } from "../../../src/pricing/aws/types.js";

// ---------------------------------------------------------------------------
// CSV + JSON fixtures
// ---------------------------------------------------------------------------

// Column positions — these MUST match what the bulk-loader looks up by name.
// The bulk-loader scans the header row for exact string matches, so we list
// the real AWS column names here.
const HEADER_COLS = [
  "SKU", // 0
  "OfferTermCode", // 1
  "RateCode", // 2
  "TermType", // 3
  "PriceDescription", // 4
  "EffectiveDate", // 5
  "StartingRange", // 6
  "EndingRange", // 7
  "Unit", // 8
  "PricePerUnit", // 9
  "Currency", // 10
  "RelatedTo", // 11
  "LeaseContractLength", // 12
  "PurchaseOption", // 13
  "OfferingClass", // 14
  "Product Family", // 15
  "serviceCode", // 16
  "Location", // 17
  "Location Type", // 18
  "Instance Type", // 19
  "Current Generation", // 20
  "Instance Family", // 21
  "vCPU", // 22
  "Tenancy", // 23
  "Operating System", // 24
  "Capacity Status", // 25
] as const;

const CSV_HEADER = HEADER_COLS.map((c) => `"${c}"`).join(",");

const COL = {
  SKU: 0,
  TermType: 3,
  Unit: 8,
  PricePerUnit: 9,
  ProductFamily: 15,
  InstanceType: 19,
  Tenancy: 23,
  OS: 24,
  CapacityStatus: 25,
} as const;

/**
 * Build a minimal CSV line for a Compute Instance / OnDemand / Shared row.
 * Column indices align with HEADER_COLS above.
 */
function buildCsvRow(opts: {
  sku: string;
  instanceType: string;
  os: string;
  tenancy?: string;
  termType?: string;
  capacityStatus?: string;
  productFamily?: string;
  price: string;
  unit?: string;
}): string {
  const {
    sku,
    instanceType,
    os,
    tenancy = "Shared",
    termType = "OnDemand",
    capacityStatus = "Used",
    productFamily = "Compute Instance",
    price,
    unit = "Hrs",
  } = opts;

  const fields: string[] = new Array(HEADER_COLS.length).fill("");
  fields[COL.SKU] = sku;
  fields[COL.TermType] = termType;
  fields[COL.Unit] = unit;
  fields[COL.PricePerUnit] = price;
  fields[COL.ProductFamily] = productFamily;
  fields[COL.InstanceType] = instanceType;
  fields[COL.Tenancy] = tenancy;
  fields[COL.OS] = os;
  fields[COL.CapacityStatus] = capacityStatus;

  return fields.map((f) => `"${f}"`).join(",");
}

function buildBulkJsonCompute(sku: string, instanceType: string, price: string) {
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
          instanceType,
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
                rateCode: `${sku}.r1`,
                description: "desc",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: price },
                appliesTo: [],
              },
            },
            termAttributes: {},
          },
        },
      },
    },
  } satisfies AwsBulkPricingResponse;
}

function buildBulkJsonRds(sku: string, instanceClass: string, engine: string, price: string) {
  return {
    formatVersion: "v1.0",
    disclaimer: "test",
    offerCode: "AmazonRDS",
    version: "test",
    publicationDate: "2026-04-01T00:00:00Z",
    products: {
      [sku]: {
        sku,
        productFamily: "Database Instance",
        attributes: {
          instanceType: instanceClass,
          databaseEngine: engine,
          deploymentOption: "Single-AZ",
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
                rateCode: `${sku}.r1`,
                description: "RDS desc",
                beginRange: "0",
                endRange: "Inf",
                unit: "Hrs",
                pricePerUnit: { USD: price },
                appliesTo: [],
              },
            },
            termAttributes: {},
          },
        },
      },
    },
  } satisfies AwsBulkPricingResponse;
}

function buildBulkJsonEbs(sku: string, volumeType: string, price: string) {
  return {
    formatVersion: "v1.0",
    disclaimer: "test",
    offerCode: "AmazonEC2",
    version: "test",
    publicationDate: "2026-04-01T00:00:00Z",
    products: {
      [sku]: {
        sku,
        productFamily: "Storage",
        attributes: {
          volumeApiName: volumeType,
          volumeType: `General Purpose (${volumeType})`,
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
                rateCode: `${sku}.r1`,
                description: "EBS desc",
                beginRange: "0",
                endRange: "Inf",
                unit: "GB-Mo",
                pricePerUnit: { USD: price },
                appliesTo: [],
              },
            },
            termAttributes: {},
          },
        },
      },
    },
  } satisfies AwsBulkPricingResponse;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("AwsBulkLoader — CSV streaming path", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-aws-bulk-test");
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("extracts and caches a price from a single-row CSV response", async () => {
    const csv =
      [
        '"Publication Date","2026-04-01T00:00:00Z"',
        CSV_HEADER,
        buildCsvRow({
          sku: "SKUAAA",
          instanceType: "t3.medium",
          os: "Linux",
          price: "0.0416",
        }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.medium", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.0416, 4);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.effective_date).toBe("2026-04-01T00:00:00.000Z");
  });

  it("handles CSV split across multiple chunks (leftover crosses chunk boundary)", async () => {
    const line = buildCsvRow({
      sku: "SKUBBB",
      instanceType: "t3.small",
      os: "Linux",
      price: "0.0208",
    });
    // Split mid-line so the streaming parser must stitch chunks together.
    const splitPoint = Math.floor(line.length / 2);
    const chunks = [
      '"Publication Date","2026-03-15T00:00:00Z"\n',
      CSV_HEADER + "\n",
      line.slice(0, splitPoint),
      line.slice(splitPoint) + "\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeMultiChunkResponse(chunks)),
    );

    const result = await loader.getComputePrice("t3.small", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.0208, 4);
    expect(result!.effective_date).toBe("2026-03-15T00:00:00.000Z");
  });

  it("processes a final line left in 'leftover' when the stream ends without a newline", async () => {
    const lines = [
      '"Publication Date","2026-04-01T00:00:00Z"',
      CSV_HEADER,
      buildCsvRow({ sku: "SKUCCC", instanceType: "t3.nano", os: "Linux", price: "0.0052" }),
    ];
    // Join with \n and DO NOT append a trailing newline — the last row lives
    // in the "leftover" tail logic.
    const csv = lines.join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.nano", "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.0052, 4);
  });

  it("leftover tail skips rows whose pre-filter fails (no OnDemand marker)", async () => {
    // A leftover line that lacks "OnDemand" is ignored by the tail handler.
    const fields: string[] = new Array(HEADER_COLS.length).fill("");
    fields[COL.SKU] = "LEFTNO";
    fields[COL.TermType] = "Reserved";
    fields[COL.Unit] = "Hrs";
    fields[COL.PricePerUnit] = "0.1";
    fields[COL.ProductFamily] = "Compute Instance";
    fields[COL.InstanceType] = "t3.leftover-skip";
    fields[COL.Tenancy] = "Shared";
    fields[COL.OS] = "Linux";
    fields[COL.CapacityStatus] = "Used";
    const row = fields.map((f) => `"${f}"`).join(",");

    // No trailing newline — row lives in leftover. Pre-filter in tail: needs
    // both "OnDemand" and "Compute Instance". This row has the latter but
    // not the former → skipped.
    const csv = [CSV_HEADER, row].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.leftover-skip", "us-east-1");
    expect(result).toBeNull();
  });

  it("leftover tail skips non-finite / non-positive prices", async () => {
    const row = buildCsvRow({
      sku: "LEFTBAD",
      instanceType: "t3.leftover-bad",
      os: "Linux",
      price: "-0.5",
    });
    const csv = [CSV_HEADER, row].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.leftover-bad", "us-east-1");
    expect(result).toBeNull();
  });

  it("ignores non-OnDemand / non-Compute Instance rows (pre-filter)", async () => {
    const csv =
      [
        CSV_HEADER,
        // Row that would match instanceType but wrong term type (Reserved).
        // termType="Reserved" → line does not include "OnDemand" → pre-filter skips.
        buildCsvRow({
          sku: "SKUZZZ",
          instanceType: "t3.filter-test-A",
          os: "Linux",
          termType: "Reserved",
          price: "0.05",
        }),
        // Row with productFamily="Dedicated Host" — pre-filter passes
        // (line still includes both "OnDemand" and "Compute Instance" since
        // the latter appears elsewhere... actually it doesn't, so pre-filter
        // kills it at the "Compute Instance" check).
        buildCsvRow({
          sku: "SKUYYY",
          instanceType: "t3.filter-test-B",
          os: "Linux",
          productFamily: "Dedicated Host",
          price: "0.06",
        }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    // Neither row should get cached under the live key; fallback path runs
    // for each lookup. Since these instanceTypes aren't in the fallback
    // table, both return null.
    const a = await loader.getComputePrice("t3.filter-test-A", "us-east-1");
    const b = await loader.getComputePrice("t3.filter-test-B", "us-east-1");
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("skips rows whose TermType is not 'OnDemand' even when pre-filter passes", async () => {
    // Build a row where TermType field is "Reserved" but the literal
    // "OnDemand" appears elsewhere in the row (via PriceDescription), so
    // the pre-filter passes and we reach the TermType column check.
    const fields: string[] = new Array(HEADER_COLS.length).fill("");
    fields[COL.SKU] = "RESINBODY";
    fields[COL.TermType] = "Reserved";
    fields[COL.Unit] = "Hrs";
    fields[COL.PricePerUnit] = "0.07";
    fields[COL.ProductFamily] = "Compute Instance";
    fields[COL.InstanceType] = "t3.termtype-test";
    fields[COL.Tenancy] = "Shared";
    fields[COL.OS] = "Linux";
    fields[COL.CapacityStatus] = "Used";
    // Stuff "OnDemand" into the PriceDescription (index 4) so the pre-filter
    // passes but the typed column check kicks in.
    fields[4] = "OnDemand mimicry";
    const row = fields.map((f) => `"${f}"`).join(",");

    const csv = [CSV_HEADER, row].join("\n") + "\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.termtype-test", "us-east-1");
    expect(result).toBeNull();
  });

  it("skips rows whose Tenancy is not 'Shared'", async () => {
    // Trailing \n forces the row into the main streaming loop (not the
    // leftover tail) so the tenancy filter fires.
    const csv =
      [
        CSV_HEADER,
        buildCsvRow({
          sku: "DHOST1",
          instanceType: "t3.dedicated-test",
          os: "Linux",
          tenancy: "Dedicated",
          price: "0.05",
        }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    // Dedicated tenancy row filtered out, no fallback entry for this
    // synthetic instance type → null.
    const result = await loader.getComputePrice("t3.dedicated-test", "us-east-1");
    expect(result).toBeNull();
  });

  it("skips rows whose Capacity Status is not 'Used'", async () => {
    const csv =
      [
        CSV_HEADER,
        buildCsvRow({
          sku: "CAPSTATUS1",
          instanceType: "t3.capstatus-test",
          os: "Linux",
          capacityStatus: "UnusedCapacityReservation",
          price: "0.05",
        }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.capstatus-test", "us-east-1");
    expect(result).toBeNull();
  });

  it("skips non-finite / non-positive prices in the CSV", async () => {
    const csv =
      [
        CSV_HEADER,
        buildCsvRow({ sku: "BAD1", instanceType: "t3.huge", os: "Linux", price: "NaN" }),
        buildCsvRow({ sku: "BAD2", instanceType: "t3.huge", os: "Linux", price: "0" }),
        buildCsvRow({ sku: "BAD3", instanceType: "t3.huge", os: "Linux", price: "-1" }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    // All rows skipped → no entry for t3.huge → fallback path fails → null.
    const result = await loader.getComputePrice("t3.huge", "us-east-1");
    expect(result).toBeNull();
  });

  it("skips rows with empty instanceType / os / price fields", async () => {
    const csv =
      [
        CSV_HEADER,
        buildCsvRow({ sku: "EMP1", instanceType: "", os: "Linux", price: "0.05" }),
        buildCsvRow({ sku: "EMP2", instanceType: "t3.empty", os: "", price: "0.05" }),
        buildCsvRow({ sku: "EMP3", instanceType: "t3.empty2", os: "Linux", price: "" }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    // No cached live rows → fallback kicks in → unknown instance → null.
    const result = await loader.getComputePrice("t3.empty", "us-east-1");
    expect(result).toBeNull();
  });

  it("aborts and falls back when header is missing required columns", async () => {
    // Header row without "Instance Type" or "PricePerUnit" — the bulk loader
    // must roll back the batch and return false (triggering fallback).
    const csv = ['"Publication Date","2026-04-01T00:00:00Z"', '"SKU","Foo","Bar"'].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const result = await loader.getComputePrice("t3.medium", "us-east-1");
    // Fallback pricing should succeed for a known instance type.
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("falls back when fetch returns non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeErrorResponse(503)),
    );

    const result = await loader.getComputePrice("t3.medium", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("falls back when fetch rejects entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      }),
    );

    const result = await loader.getComputePrice("t3.medium", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("deduplicates concurrent CSV fetches for the same region", async () => {
    // Two concurrent fetches for the same region should hit fetch once.
    const csv =
      [
        CSV_HEADER,
        buildCsvRow({ sku: "DEDUP", instanceType: "t3.micro", os: "Linux", price: "0.0104" }),
      ].join("\n") + "\n";

    const fetchMock = vi.fn(async () => makeStreamingTextResponse(csv));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      loader.getComputePrice("t3.micro", "us-east-1"),
      loader.getComputePrice("t3.micro", "us-east-1"),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid AWS region before calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Invalid region throws synchronously from assertValidAwsRegion; the
    // bulk loader catches it inside the try/catch and falls back.
    const result = await loader.getComputePrice("t3.medium", "bogus region");
    expect(result).not.toBeNull(); // fallback succeeds
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores the Publication Date metadata row when value is unparseable", async () => {
    const csv =
      [
        '"Publication Date","not-a-real-date"',
        CSV_HEADER,
        buildCsvRow({ sku: "DATE1", instanceType: "m5.large", os: "Linux", price: "0.096" }),
      ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeStreamingTextResponse(csv)),
    );

    const before = Date.now();
    const result = await loader.getComputePrice("m5.large", "us-east-1");
    expect(result).not.toBeNull();
    // effective_date falls back to "now" — recent timestamp, not 1970.
    expect(Date.parse(result!.effective_date)).toBeGreaterThanOrEqual(before - 1000);
  });
});

// ---------------------------------------------------------------------------
// Bulk JSON path (RDS / EBS primarily, since EC2 now uses CSV)
// ---------------------------------------------------------------------------

describe("AwsBulkLoader — bulk JSON path", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-aws-bulk-json-test");
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
    resetAllCircuits();
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    resetAllCircuits();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("extracts an RDS price from a bulk JSON response", async () => {
    const body = buildBulkJsonRds("RDSSKU1", "db.t3.medium", "MySQL", "0.034");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeJsonResponse(body)),
    );

    const result = await loader.getDatabasePrice("db.t3.medium", "us-east-1", "MySQL");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("live");
  });

  it("falls back when the bulk JSON response has no matching SKU", async () => {
    const body = buildBulkJsonRds("RDSSKU2", "db.t3.medium", "MySQL", "0.034");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeJsonResponse(body)),
    );

    // Asking for a non-matching instance class — extractor returns null,
    // loader falls back to hardcoded pricing.
    const result = await loader.getDatabasePrice("db.m5.large", "us-east-1", "MySQL");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("falls back when the bulk JSON fetch returns 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeErrorResponse(500)),
    );

    const result = await loader.getDatabasePrice("db.t3.medium", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("extracts an EBS price from a bulk JSON response", async () => {
    // The EBS flow calls getStoragePrice -> fetchBulkPricing("AmazonEC2").
    // Wire a JSON response matching the gp3 storage shape.
    const body = buildBulkJsonEbs("EBSSKU1", "gp3", "0.08");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeJsonResponse(body)),
    );

    const result = await loader.getStoragePrice("gp3", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("ebs");
  });

  it("falls back when EBS bulk JSON has no matching volume", async () => {
    const body = buildBulkJsonEbs("EBSSKU2", "io2", "0.125");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeJsonResponse(body)),
    );

    const result = await loader.getStoragePrice("gp3", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("fallback");
  });

  it("extracts an EC2 price via the bulk-JSON fallback when CSV returns no body", async () => {
    // First call: CSV streaming returns a Response with no body — this
    // triggers the "res.body is null" branch, falling through to JSON.
    // Second call: bulk JSON response with matching SKU.
    const json = buildBulkJsonCompute("EC2JSON1", "t3.xlarge", "0.1664");
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    let callCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // First call is the CSV stream — return a 200 with null body.
          return new Response(null, { status: 200 });
        }
        // Second call is the JSON bulk fallback.
        return new Response(jsonBytes, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await loader.getComputePrice("t3.xlarge", "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.attributes.pricing_source).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// ALB / NAT / EKS — region-multiplier coverage
// ---------------------------------------------------------------------------

describe("AwsBulkLoader — fixed-price services", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-aws-fixed-test");
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("applies regional multipliers to ALB pricing", async () => {
    const us = await loader.getLoadBalancerPrice("us-east-1");
    const eu = await loader.getLoadBalancerPrice("eu-west-1");
    const ap = await loader.getLoadBalancerPrice("ap-southeast-1");

    expect(us).not.toBeNull();
    expect(eu).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(eu!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });

  it("applies regional multipliers to NAT Gateway pricing", async () => {
    const us = await loader.getNatGatewayPrice("us-east-1");
    const eu = await loader.getNatGatewayPrice("eu-west-1");

    expect(us).not.toBeNull();
    expect(eu).not.toBeNull();
    // Both the hourly and the per-GB should scale by the multiplier.
    expect(parseFloat(eu!.attributes.per_gb_price as string)).toBeGreaterThan(
      parseFloat(us!.attributes.per_gb_price as string),
    );
  });

  it("applies regional multipliers to EKS pricing", async () => {
    const us = await loader.getKubernetesPrice("us-east-1");
    const ap = await loader.getKubernetesPrice("ap-southeast-1");

    expect(us).not.toBeNull();
    expect(ap).not.toBeNull();
    expect(ap!.price_per_unit).toBeGreaterThan(us!.price_per_unit);
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour — hits return early without invoking fetch
// ---------------------------------------------------------------------------

describe("AwsBulkLoader — cache hit short-circuit", () => {
  let dbPath: string;
  let cache: PricingCache;
  let loader: AwsBulkLoader;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-aws-cache-test");
    cache = new PricingCache(dbPath);
    loader = new AwsBulkLoader(cache);
  });

  afterEach(() => {
    cache?.close();
    vi.unstubAllGlobals();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns from cache on the second call without re-fetching (compute)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    // First call populates the cache with fallback data.
    const first = await loader.getComputePrice("t3.small", "us-east-1");
    expect(first).not.toBeNull();
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Second call should short-circuit via the cache — no new fetch.
    const second = await loader.getComputePrice("t3.small", "us-east-1");
    expect(second).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns from cache on the second call without re-fetching (database)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await loader.getDatabasePrice("db.t3.small", "us-east-1");
    const callsAfterFirst = fetchMock.mock.calls.length;

    await loader.getDatabasePrice("db.t3.small", "us-east-1");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns from cache on the second call without re-fetching (storage)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await loader.getStoragePrice("gp3", "us-east-1");
    const callsAfterFirst = fetchMock.mock.calls.length;

    await loader.getStoragePrice("gp3", "us-east-1");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
