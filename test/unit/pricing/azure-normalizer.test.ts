import { describe, it, expect } from "vitest";
import {
  normalizeAzureCompute,
  normalizeAzureDatabase,
  normalizeAzureStorage,
} from "../../../src/pricing/azure/azure-normalizer.js";
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
 * Build a partial retail-price item missing a given set of fields. This is
 * how the Retail API surfaces items that don't fit the full schema (e.g.
 * preview regions or newly-launched SKUs), so the normaliser's nullish
 * fallbacks must tolerate it without throwing.
 */
function makeSparseItem(
  remove: (keyof AzureRetailPriceItem)[],
  overrides: Partial<AzureRetailPriceItem> = {},
): AzureRetailPriceItem {
  const base = makeItem(overrides);
  for (const key of remove) {
    // Delete so the field is genuinely undefined; the `?? fallback`
    // branches in azure-normalizer.ts only hit when the value is undefined.
    delete (base as Partial<AzureRetailPriceItem>)[key];
  }
  return base;
}

// ---------------------------------------------------------------------------
// normalizeAzureCompute
// ---------------------------------------------------------------------------

describe("normalizeAzureCompute", () => {
  it("maps a fully populated retail item to a NormalizedPrice", () => {
    const out = normalizeAzureCompute(makeItem());

    expect(out.provider).toBe("azure");
    expect(out.service).toBe("virtual-machines");
    expect(out.resource_type).toBe("D2s v5");
    expect(out.region).toBe("eastus");
    expect(out.unit).toBe("1 Hour");
    expect(out.price_per_unit).toBeCloseTo(0.096, 4);
    expect(out.currency).toBe("USD");
    expect(out.description).toBe("Virtual Machines Dsv5 Series");
    expect(out.attributes.pricing_source).toBe("live");
    expect(out.effective_date).toBe("2026-01-01T00:00:00Z");
  });

  it("falls back to armSkuName when skuName is missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["skuName"]));
    expect(out.resource_type).toBe("Standard_D2s_v5");
  });

  it("falls back to 'unknown' when both skuName and armSkuName are missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["skuName", "armSkuName"]));
    expect(out.resource_type).toBe("unknown");
  });

  it("falls back to location when armRegionName is missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["armRegionName"]));
    expect(out.region).toBe("US East");
  });

  it("falls back to empty string when region fields are all missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["armRegionName", "location"]));
    expect(out.region).toBe("");
  });

  it("uses '1 Hour' when unitOfMeasure is missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["unitOfMeasure"]));
    expect(out.unit).toBe("1 Hour");
  });

  it("uses unitPrice when retailPrice is missing", () => {
    const item = makeSparseItem(["retailPrice"], { unitPrice: 0.05 });
    const out = normalizeAzureCompute(item);
    expect(out.price_per_unit).toBeCloseTo(0.05, 4);
  });

  it("uses 0 when both retailPrice and unitPrice are missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["retailPrice", "unitPrice"]));
    expect(out.price_per_unit).toBe(0);
  });

  it("falls back to 'USD' when currencyCode is missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["currencyCode"]));
    expect(out.currency).toBe("USD");
  });

  it("emits tier only when tierMinimumUnits is defined", () => {
    expect(normalizeAzureCompute(makeItem({ tierMinimumUnits: 10 })).tier).toBe("10");
    expect(normalizeAzureCompute(makeItem({ tierMinimumUnits: 0 })).tier).toBe("0");
    expect(normalizeAzureCompute(makeSparseItem(["tierMinimumUnits"])).tier).toBeUndefined();
  });

  it("omits description when productName is missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["productName"]));
    expect(out.description).toBeUndefined();
  });

  it("uses serviceName attribute default 'Virtual Machines' when missing", () => {
    const out = normalizeAzureCompute(makeSparseItem(["serviceName"]));
    expect(out.attributes.service_name).toBe("Virtual Machines");
  });

  it("coalesces each attribute to empty string when source field is missing", () => {
    const out = normalizeAzureCompute(
      makeSparseItem(["skuName", "armSkuName", "productName", "meterName"]),
    );
    expect(out.attributes.sku_name).toBe("");
    expect(out.attributes.arm_sku_name).toBe("");
    expect(out.attributes.product_name).toBe("");
    expect(out.attributes.meter_name).toBe("");
  });

  it("defaults effective_date to now-ish when effectiveStartDate is missing", () => {
    const before = Date.now();
    const out = normalizeAzureCompute(makeSparseItem(["effectiveStartDate"]));
    const parsed = Date.parse(out.effective_date);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

// ---------------------------------------------------------------------------
// normalizeAzureDatabase
// ---------------------------------------------------------------------------

describe("normalizeAzureDatabase", () => {
  it("maps a fully populated item and sets service=azure-database", () => {
    const out = normalizeAzureDatabase(
      makeItem({
        serviceName: "Azure Database for PostgreSQL",
        productName: "PostgreSQL Flexible Server General Purpose Dsv5 Series Compute",
      }),
    );

    expect(out.provider).toBe("azure");
    expect(out.service).toBe("azure-database");
    expect(out.attributes.service_name).toBe("Azure Database for PostgreSQL");
    expect(out.attributes.pricing_source).toBe("live");
  });

  it("uses armSkuName when skuName is missing", () => {
    const out = normalizeAzureDatabase(makeSparseItem(["skuName"]));
    expect(out.resource_type).toBe("Standard_D2s_v5");
  });

  it("uses '1 Hour' when unitOfMeasure is missing", () => {
    const out = normalizeAzureDatabase(makeSparseItem(["unitOfMeasure"]));
    expect(out.unit).toBe("1 Hour");
  });

  it("uses unitPrice when retailPrice is missing", () => {
    const out = normalizeAzureDatabase(makeSparseItem(["retailPrice"], { unitPrice: 0.125 }));
    expect(out.price_per_unit).toBeCloseTo(0.125, 4);
  });

  it("falls back to empty service_name attribute when serviceName is missing", () => {
    // Note: unlike normalizeAzureCompute, the DB variant does NOT default
    // service_name to a fixed string — it coalesces to "".
    const out = normalizeAzureDatabase(makeSparseItem(["serviceName"]));
    expect(out.attributes.service_name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeAzureStorage
// ---------------------------------------------------------------------------

describe("normalizeAzureStorage", () => {
  it("maps a fully populated item and sets service=managed-disks", () => {
    const out = normalizeAzureStorage(
      makeItem({
        serviceName: "Storage",
        skuName: "Premium_LRS P10",
        productName: "Premium SSD Managed Disks P10 LRS",
        unitOfMeasure: "1/Month",
      }),
    );

    expect(out.provider).toBe("azure");
    expect(out.service).toBe("managed-disks");
    expect(out.resource_type).toBe("Premium_LRS P10");
    expect(out.unit).toBe("1/Month");
  });

  it("uses '1 GiB/Month' default when unitOfMeasure is missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["unitOfMeasure"]));
    expect(out.unit).toBe("1 GiB/Month");
  });

  it("falls back to armSkuName when skuName is missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["skuName"]));
    expect(out.resource_type).toBe("Standard_D2s_v5");
  });

  it("returns 'unknown' when both sku fields are missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["skuName", "armSkuName"]));
    expect(out.resource_type).toBe("unknown");
  });

  it("uses unitPrice when retailPrice is missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["retailPrice"], { unitPrice: 0.024 }));
    expect(out.price_per_unit).toBeCloseTo(0.024, 4);
  });

  it("returns 0 price when both retailPrice and unitPrice are missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["retailPrice", "unitPrice"]));
    expect(out.price_per_unit).toBe(0);
  });

  it("falls back to 'USD' currency when currencyCode is missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["currencyCode"]));
    expect(out.currency).toBe("USD");
  });

  it("omits description when productName is missing", () => {
    const out = normalizeAzureStorage(makeSparseItem(["productName"]));
    expect(out.description).toBeUndefined();
  });

  it("defaults effective_date to now-ish when effectiveStartDate is missing", () => {
    const before = Date.now();
    const out = normalizeAzureStorage(makeSparseItem(["effectiveStartDate"]));
    const parsed = Date.parse(out.effective_date);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("coalesces empty strings for absent attributes", () => {
    const out = normalizeAzureStorage(
      makeSparseItem(["skuName", "serviceName", "productName", "meterName"]),
    );
    expect(out.attributes.sku_name).toBe("");
    expect(out.attributes.service_name).toBe("");
    expect(out.attributes.product_name).toBe("");
    expect(out.attributes.meter_name).toBe("");
  });
});
