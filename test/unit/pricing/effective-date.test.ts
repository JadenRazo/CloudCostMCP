/**
 * Effective-date propagation unit tests.
 *
 * Wave 1 added support for propagating upstream `effectiveStartDate` /
 * `effectiveDate` fields through the normalizers so downstream consumers can
 * tell whether a cached price is current. These tests feed each normalizer a
 * synthetic API response with a known date and assert the normalized output
 * carries it through. A regression that hardcodes `new Date()` or drops the
 * field will be caught here.
 */

import { describe, it, expect } from "vitest";

import {
  normalizeAwsCompute,
  normalizeAwsDatabase,
  normalizeAwsStorage,
} from "../../../src/pricing/aws/aws-normalizer.js";
import {
  normalizeAzureCompute,
  normalizeAzureDatabase,
  normalizeAzureStorage,
} from "../../../src/pricing/azure/azure-normalizer.js";
import {
  normalizeGcpLiveCompute,
  normalizeGcpLiveDatabase,
  normalizeGcpLiveStorage,
} from "../../../src/pricing/gcp/gcp-normalizer.js";
import type { AzureRetailPriceItem } from "../../../src/pricing/azure/types.js";

// ---------------------------------------------------------------------------
// Azure — directly consumes item.effectiveStartDate
// ---------------------------------------------------------------------------

describe("Azure normalizers propagate effectiveStartDate", () => {
  const baseItem: AzureRetailPriceItem = {
    currencyCode: "USD",
    tierMinimumUnits: 0,
    retailPrice: 0.096,
    unitPrice: 0.096,
    armRegionName: "eastus",
    location: "US East",
    effectiveStartDate: "2025-07-01T00:00:00Z",
    meterId: "m1",
    meterName: "D2s v5",
    productId: "p1",
    skuId: "sku1",
    productName: "Virtual Machines Dv5 Series",
    skuName: "D2s v5",
    serviceName: "Virtual Machines",
    serviceId: "sv1",
    serviceFamily: "Compute",
    unitOfMeasure: "1 Hour",
    type: "Consumption",
    isPrimaryMeterRegion: true,
    armSkuName: "Standard_D2s_v5",
  };

  it("normalizeAzureCompute copies effectiveStartDate to effective_date", () => {
    const result = normalizeAzureCompute(baseItem);
    expect(result.effective_date).toBe("2025-07-01T00:00:00Z");
  });

  it("normalizeAzureDatabase copies effectiveStartDate to effective_date", () => {
    const result = normalizeAzureDatabase({
      ...baseItem,
      serviceName: "SQL Database",
      productName: "SQL Database Single",
      effectiveStartDate: "2026-01-15T00:00:00Z",
    });
    expect(result.effective_date).toBe("2026-01-15T00:00:00Z");
  });

  it("normalizeAzureStorage copies effectiveStartDate to effective_date", () => {
    const result = normalizeAzureStorage({
      ...baseItem,
      serviceName: "Storage",
      productName: "Premium SSD Managed Disks",
      unitOfMeasure: "1 GiB/Month",
      effectiveStartDate: "2026-03-20T00:00:00Z",
    });
    expect(result.effective_date).toBe("2026-03-20T00:00:00Z");
  });

  it("falls back to a valid ISO date when effectiveStartDate is missing", () => {
    const result = normalizeAzureCompute({
      ...baseItem,
      // Simulate a malformed upstream row where the date is absent.
      effectiveStartDate: undefined as unknown as string,
    });
    expect(result.effective_date).toBeDefined();
    expect(() => new Date(result.effective_date as string)).not.toThrow();
    expect(Number.isNaN(new Date(result.effective_date as string).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GCP — live normalizers accept an explicit effectiveDate argument
// ---------------------------------------------------------------------------

describe("GCP live normalizers propagate effectiveDate", () => {
  it("normalizeGcpLiveCompute carries the effectiveDate argument through", () => {
    const result = normalizeGcpLiveCompute(
      "e2-standard-2",
      0.067006,
      "us-central1",
      "ABCD-1234-5678",
      "2025-09-01T00:00:00Z",
    );
    expect(result.effective_date).toBe("2025-09-01T00:00:00Z");
    expect(result.attributes?.sku_id).toBe("ABCD-1234-5678");
  });

  it("normalizeGcpLiveDatabase carries the effectiveDate argument through", () => {
    const result = normalizeGcpLiveDatabase(
      "db-n1-standard-1",
      0.0965,
      "us-central1",
      "SQL-SKU-1",
      "2025-10-15T00:00:00Z",
    );
    expect(result.effective_date).toBe("2025-10-15T00:00:00Z");
  });

  it("normalizeGcpLiveStorage carries the effectiveDate argument through", () => {
    const result = normalizeGcpLiveStorage(
      "standard",
      0.02,
      "us-central1",
      "STORAGE-SKU-1",
      "2026-02-01T00:00:00Z",
    );
    expect(result.effective_date).toBe("2026-02-01T00:00:00Z");
  });

  it("defaults to a valid ISO date when effectiveDate is omitted", () => {
    const result = normalizeGcpLiveCompute("e2-small", 0.02, "us-central1", "SKU-X");
    expect(result.effective_date).toBeDefined();
    expect(Number.isNaN(new Date(result.effective_date as string).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AWS — bulk normalizer stamps effective_date at normalization time; we only
// verify it produces a valid ISO string so a regression that drops the field
// entirely (or sets it to a non-string) is caught.
// ---------------------------------------------------------------------------

describe("AWS normalizers emit a valid effective_date", () => {
  const rawProduct = {
    attributes: {
      instanceType: "m5.large",
      operatingSystem: "Linux",
      vcpu: "2",
      memory: "8 GiB",
      tenancy: "Shared",
    },
  };
  const rawPrice = {
    terms: {
      OnDemand: {
        "SKU1.TERM1": {
          priceDimensions: {
            "SKU1.TERM1.RATE1": {
              pricePerUnit: { USD: "0.096" },
              unit: "Hrs",
            },
          },
        },
      },
    },
  };

  const isValidIso = (s: string | undefined): boolean => {
    if (typeof s !== "string") return false;
    const t = new Date(s).getTime();
    return !Number.isNaN(t);
  };

  it("normalizeAwsCompute produces a parseable ISO effective_date", () => {
    const result = normalizeAwsCompute(rawProduct, rawPrice, "us-east-1");
    expect(isValidIso(result.effective_date)).toBe(true);
  });

  it("normalizeAwsDatabase produces a parseable ISO effective_date", () => {
    const result = normalizeAwsDatabase(rawProduct, rawPrice, "us-east-1");
    expect(isValidIso(result.effective_date)).toBe(true);
  });

  it("normalizeAwsStorage produces a parseable ISO effective_date", () => {
    const result = normalizeAwsStorage(
      { attributes: { volumeApiName: "gp3" } },
      rawPrice,
      "us-east-1",
    );
    expect(isValidIso(result.effective_date)).toBe(true);
  });
});
