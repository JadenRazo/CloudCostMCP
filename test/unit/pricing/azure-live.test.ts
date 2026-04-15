import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AzureRetailClient } from "../../../src/pricing/azure/retail-client.js";
import { ARM_REGION_MAP, toArmRegionName } from "../../../src/pricing/azure/arm-regions.js";
import {
  calculateAzureReservedPricingLive,
  calculateReservedPricing,
} from "../../../src/calculator/reserved.js";

// ---------------------------------------------------------------------------
// Fetch-stub helpers
// ---------------------------------------------------------------------------

interface StubItem {
  armRegionName: string;
  armSkuName: string;
  skuName: string;
  meterName: string;
  productName: string;
  serviceName: string;
  retailPrice: number;
  unitPrice: number;
  unitOfMeasure: string;
  currencyCode: string;
  tierMinimumUnits: number;
  effectiveStartDate: string;
  meterId: string;
  skuId: string;
  productId: string;
  serviceId: string;
  serviceFamily: string;
  location: string;
  type: string;
  isPrimaryMeterRegion: boolean;
  reservationTerm?: string;
  priceType?: string;
}

function makeItem(overrides: Partial<StubItem>): StubItem {
  return {
    armRegionName: "eastus",
    armSkuName: "Standard_D2s_v5",
    skuName: "D2s v5",
    meterName: "D2s v5",
    productName: "Virtual Machines Dsv5 Series",
    serviceName: "Virtual Machines",
    retailPrice: 0.096,
    unitPrice: 0.096,
    unitOfMeasure: "1 Hour",
    currencyCode: "USD",
    tierMinimumUnits: 0,
    effectiveStartDate: "2026-01-01T00:00:00Z",
    meterId: "meter-1",
    skuId: "sku-1",
    productId: "prod-1",
    serviceId: "svc-1",
    serviceFamily: "Compute",
    location: "US East",
    type: "Consumption",
    isPrimaryMeterRegion: true,
    ...overrides,
  };
}

function stubFetchOnce(items: StubItem[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        BillingCurrency: "USD",
        CustomerEntityId: "",
        CustomerEntityType: "",
        Items: items,
        NextPageLink: null,
        Count: items.length,
      }),
    })) as unknown as typeof fetch,
  );
}

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-azure-live-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------

describe("ARM_REGION_MAP / toArmRegionName", () => {
  it("canonicalises lowercase ARM names as-is", () => {
    expect(toArmRegionName("eastus")).toBe("eastus");
    expect(toArmRegionName("westeurope")).toBe("westeurope");
    expect(toArmRegionName("australiaeast")).toBe("australiaeast");
    expect(toArmRegionName("brazilsouth")).toBe("brazilsouth");
  });

  it("accepts friendly display names with spaces or hyphens", () => {
    expect(toArmRegionName("East US")).toBe("eastus");
    expect(toArmRegionName("East US 2")).toBe("eastus2");
    expect(toArmRegionName("West Europe")).toBe("westeurope");
    expect(toArmRegionName("australia-east")).toBe("australiaeast");
    expect(toArmRegionName("Germany West Central")).toBe("germanywestcentral");
  });

  it("falls back to lowercase/strip for unknown regions", () => {
    expect(toArmRegionName("Moon Base One")).toBe("moonbaseone");
  });

  it("exports a map covering at least 32 Azure regions", () => {
    expect(Object.keys(ARM_REGION_MAP).length).toBeGreaterThanOrEqual(32);
  });
});

describe("AzureRetailClient.getSpotPrice", () => {
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
    vi.unstubAllGlobals();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the Spot-labelled row when the API surfaces one", async () => {
    stubFetchOnce([
      makeItem({
        skuName: "D2s v5",
        meterName: "D2s v5",
        retailPrice: 0.096,
      }),
      makeItem({
        skuName: "D2s v5 Spot",
        meterName: "D2s v5 Spot",
        retailPrice: 0.0192,
        skuId: "sku-spot-1",
      }),
    ]);

    const result = await client.getSpotPrice("Standard_D2s_v5", "eastus");
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.0192, 4);
    expect(result!.attributes.pricing_source).toBe("live");
    expect(result!.attributes.purchase_option).toBe("spot");
    expect(result!.effective_date).toBe("2026-01-01T00:00:00Z");
  });

  it("filters out Windows spot rows when OS is linux", async () => {
    stubFetchOnce([
      makeItem({
        skuName: "D2s v5 Spot Windows",
        meterName: "D2s v5 Spot Windows",
        retailPrice: 0.05,
        skuId: "sku-spot-win",
      }),
      makeItem({
        skuName: "D2s v5 Spot",
        meterName: "D2s v5 Spot",
        retailPrice: 0.02,
        skuId: "sku-spot-lin",
      }),
    ]);

    const result = await client.getSpotPrice("Standard_D2s_v5", "eastus", "linux");
    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.02, 4);
  });

  it("returns null when no Spot row exists", async () => {
    stubFetchOnce([
      makeItem({ skuName: "D2s v5", meterName: "D2s v5", retailPrice: 0.096 }),
    ]);
    const result = await client.getSpotPrice("Standard_D2s_v5", "eastus");
    expect(result).toBeNull();
  });
});

describe("AzureRetailClient.getReservationHourlyRate", () => {
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
    vi.unstubAllGlobals();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns hourly rate when the API has a 1 Year Reservation row", async () => {
    stubFetchOnce([
      makeItem({
        retailPrice: 0.065,
        unitOfMeasure: "1 Hour",
        reservationTerm: "1 Year",
        type: "Reservation",
        skuName: "D2s v5 1 Year Reserved",
      }),
      makeItem({
        retailPrice: 0.045,
        unitOfMeasure: "1 Hour",
        reservationTerm: "3 Years",
        type: "Reservation",
        skuName: "D2s v5 3 Years Reserved",
        skuId: "sku-ri-3y",
      }),
    ]);

    const rate = await client.getReservationHourlyRate(
      "Standard_D2s_v5",
      "eastus",
      "1yr",
    );
    expect(rate).toBeCloseTo(0.065, 4);
  });

  it("converts upfront year-based units into an hourly rate", async () => {
    // 1 Year upfront at $569.40 → 569.40 / 8760 ≈ 0.065/hr
    stubFetchOnce([
      makeItem({
        retailPrice: 569.4,
        unitOfMeasure: "1/Year",
        reservationTerm: "1 Year",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate(
      "Standard_D2s_v5",
      "eastus",
      "1yr",
    );
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(569.4 / 8760, 4);
  });

  it("returns null when no reservation row matches the term", async () => {
    stubFetchOnce([
      makeItem({
        retailPrice: 0.065,
        reservationTerm: "1 Year",
        type: "Reservation",
      }),
    ]);

    const rate = await client.getReservationHourlyRate(
      "Standard_D2s_v5",
      "eastus",
      "3yr",
    );
    expect(rate).toBeNull();
  });
});

describe("calculateAzureReservedPricingLive", () => {
  it("applies live 1yr + 3yr rates when the stub client returns both", async () => {
    const stubClient = {
      async getReservationHourlyRate(
        _vm: string,
        _region: string,
        term: "1yr" | "3yr",
      ) {
        // 50% savings for 1yr, 70% savings for 3yr against $0.10/hr on-demand.
        return term === "1yr" ? 0.05 : 0.03;
      },
    };

    const monthly = 0.1 * 730; // $73/mo on-demand
    const result = await calculateAzureReservedPricingLive(
      monthly,
      0.1,
      "Standard_D2s_v5",
      "eastus",
      stubClient,
    );

    expect(result.source).toBe("live");
    const oneYr = result.options.find((o) => o.term === "1yr" && o.payment === "all_upfront");
    const threeYr = result.options.find(
      (o) => o.term === "3yr" && o.payment === "all_upfront",
    );
    expect(oneYr!.percentage_savings).toBeCloseTo(50, 1);
    expect(threeYr!.percentage_savings).toBeCloseTo(70, 1);
  });

  it("falls back to static rates when the client returns null for both terms", async () => {
    const stubClient = {
      async getReservationHourlyRate(): Promise<number | null> {
        return null;
      },
    };

    const staticResult = calculateReservedPricing(73, "azure");
    const liveResult = await calculateAzureReservedPricingLive(
      73,
      0.1,
      "Standard_D2s_v5",
      "eastus",
      stubClient,
    );

    expect(liveResult.source).toBe("fallback");
    // Same options shape/values as the static table.
    expect(liveResult.options.map((o) => o.percentage_savings)).toEqual(
      staticResult.options.map((o) => o.percentage_savings),
    );
  });

  it("ignores rates that would imply a negative discount (rev-API returned >= on-demand)", async () => {
    const stubClient = {
      async getReservationHourlyRate(
        _vm: string,
        _region: string,
        _term: "1yr" | "3yr",
      ) {
        return 0.15; // higher than on-demand
      },
    };

    const result = await calculateAzureReservedPricingLive(
      73,
      0.1,
      "Standard_D2s_v5",
      "eastus",
      stubClient,
    );
    expect(result.source).toBe("fallback");
  });
});
