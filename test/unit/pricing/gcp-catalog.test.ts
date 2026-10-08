import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleCatalog,
  catalogMapping,
  catalogRate,
  generateCatalog,
  machineComponents,
  parseCatalogMappings,
  type CatalogSku,
} from "../../../src/pricing/gcp/catalog.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/pricing/fetch-utils.js", () => ({ fetchWithRetry: fetchMock }));
const NOW = Date.parse("2026-10-08T04:00:00Z");
const REGION = "us-central1";
const csv = readFileSync("scripts/gcp/mapping.csv", "utf8");
const rules = parseCatalogMappings(csv);

function sku(
  description: string,
  group = "CPU",
  price = 0.02,
  service = "Compute Engine",
  family = "Compute",
): CatalogSku {
  return {
    skuId: description,
    description,
    category: {
      serviceDisplayName: service,
      resourceFamily: family,
      resourceGroup: group,
      usageType: "OnDemand",
    },
    serviceRegions: [REGION],
    pricingInfo: [
      {
        effectiveTime: "2026-10-08T00:00:00Z",
        pricingExpression: {
          usageUnit: group === "RAM" ? "GiBy.h" : family === "Storage" ? "GiBy.mo" : "h",
          tieredRates: [
            {
              startUsageAmount: 0,
              unitPrice: {
                currencyCode: "USD",
                units: String(Math.floor(price)),
                nanos: Math.round((price % 1) * 1e9),
              },
            },
          ],
        },
      },
    ],
  };
}

const compute = [
  sku("E2 Instance Core running in Iowa"),
  sku("E2 Instance Ram running in Iowa", "RAM", 0.003),
  sku("Storage PD Capacity in Iowa", "PDStandard", 0.04, "Compute Engine", "Storage"),
  sku("SSD backed PD Capacity in Iowa", "SSD", 0.17, "Compute Engine", "Storage"),
  sku("Balanced PD Capacity in Iowa", "SSD", 0.1, "Compute Engine", "Storage"),
  sku("Extreme PD Capacity in Iowa", "SSD", 0.125, "Compute Engine", "Storage"),
];
const buckets = [
  sku("Standard Storage Iowa", "RegionalStorage", 0.02, "Cloud Storage", "Storage"),
  sku("Nearline Storage Iowa", "NearlineStorage", 0.01, "Cloud Storage", "Storage"),
  sku("Coldline Storage Iowa", "ColdlineStorage", 0.004, "Cloud Storage", "Storage"),
  sku("Archive Storage Iowa", "ArchiveStorage", 0.0012, "Cloud Storage", "Storage"),
];
const machines = { "e2-standard-2": { cpu: 2, ram: 8 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify({ skus: url.includes("6F81") ? compute : buckets })),
    ),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owned GCP catalog generation", () => {
  it("keeps C3 and C4 mappings distinct and lets later exclusions win", () => {
    expect(catalogMapping(sku("C3 Instance Core running in Iowa"), rules)).toBe(
      "gce.compute.cpu.c3",
    );
    expect(catalogMapping(sku("C4 Instance Core running in Iowa"), rules)).toBe(
      "gce.compute.cpu.c4",
    );
    expect(
      catalogMapping(
        sku("Nearline Storage Iowa Early Delete", "NearlineStorage", 1, "Cloud Storage", "Storage"),
        rules,
      ),
    ).toBe("storage.nearline.early");
  });
  it("supports SQL LIKE escaping and ordered overrides", () => {
    const mapping = parseCatalogMappings(
      "MAPPING,SVC_DISPLAY_NAME,FAMILY,GROUP,SKU_DESCRIPTION\nfirst,Compute Engine,Compute,CPU,A._%\nsecond,Compute Engine,Compute,CPU,A._%\n",
    );
    expect(catalogMapping(sku("A.xmore"), mapping)).toBe("second");
    expect(catalogMapping(sku("ABxmore"), mapping)).toBeUndefined();
  });
  it("assembles the whole instance rather than treating per-core price as its total", () => {
    const doc = assembleCatalog([...compute, ...buckets], rules, machines, [REGION], NOW);
    expect(doc.compute.instance["e2-standard-2"].cost[REGION].hour).toBeCloseTo(0.064);
    expect(doc.compute.storage.ssd.cost[REGION].month).toBe(0.17);
    expect(doc.storage.bucket.standard.cost[REGION].month).toBe(0.02);
  });
  it("includes A100 GPU and bundled local SSD in A2 ultra hourly prices", () => {
    const a2 = [
      sku("A2 Instance Core running in Iowa"),
      sku("A2 Instance Ram running in Iowa", "RAM", 0.003),
      sku("Nvidia Tesla A100 80GB GPU running in Iowa", "GPU", 5),
      sku("SSD backed Local Storage in Iowa", "LocalSSD", 0.08, "Compute Engine", "Storage"),
    ];
    const doc = assembleCatalog(
      [...compute, ...buckets, ...a2],
      rules,
      { "a2-ultragpu-1g": { cpu: 12, ram: 170, "a100-80gb": 1, "local-ssd": 375 } },
      [REGION],
      NOW,
    );
    expect(doc.compute.instance["a2-ultragpu-1g"].cost[REGION].hour).toBeCloseTo(
      0.24 + 0.51 + 5 + (375 * 0.08) / 730,
    );
    expect(() =>
      assembleCatalog(
        [...compute, ...buckets, ...a2.slice(0, 2)],
        rules,
        { "a2-ultragpu-1g": { cpu: 12, ram: 170, "a100-80gb": 1 } },
        [REGION],
        NOW,
      ),
    ).toThrow("No complete catalog prices");
  });
  it("does not emit a region missing any instance component", () => {
    const rows = structuredClone(compute);
    rows[0].serviceRegions.push("us-east1");
    const doc = assembleCatalog([...rows, ...buckets], rules, machines, [REGION, "us-east1"], NOW);
    expect(doc.compute.instance["e2-standard-2"].cost["us-east1"]).toBeUndefined();
  });
  it("rejects ambiguous prices instead of choosing a cheaper duplicate", () => {
    const duplicate = sku("E2 Instance Core running in Other Iowa", "CPU", 0.01);
    expect(() =>
      assembleCatalog([...compute, duplicate, ...buckets], rules, machines, [REGION], NOW),
    ).toThrow("Ambiguous");
  });
  it("validates money units and excludes a zero-priced free allowance", () => {
    const item = sku("E2 Instance Core running in Iowa", "CPU", 3.5);
    expect(catalogRate(item, "h", NOW)).toBe(3.5);
    item.pricingInfo[0].pricingExpression.tieredRates.unshift({
      startUsageAmount: 0,
      unitPrice: { currencyCode: "USD", units: "0", nanos: 0 },
    });
    expect(catalogRate(item, "h", NOW)).toBe(3.5);
  });
  it.each([
    "currency",
    "unit",
    "nanos",
    "units",
    "stale",
    "future",
    "missing",
    "tiers",
    "variable",
  ])("fails closed for %s catalog pricing", (kind) => {
    const item = sku("E2 Instance Core running in Iowa");
    const info = item.pricingInfo[0];
    const money = info.pricingExpression.tieredRates[0].unitPrice;
    if (kind === "currency") money.currencyCode = "EUR";
    if (kind === "unit") info.pricingExpression.usageUnit = "GiBy.mo";
    if (kind === "nanos") money.nanos = -1;
    if (kind === "units") money.units = "NaN";
    if (kind === "stale") info.effectiveTime = "2026-10-01T00:00:00Z";
    if (kind === "future") info.effectiveTime = "2026-10-09T00:00:00Z";
    if (kind === "missing") item.pricingInfo = [];
    if (kind === "tiers") info.pricingExpression.tieredRates = [];
    if (kind === "variable")
      info.pricingExpression.tieredRates.push({
        startUsageAmount: 5,
        unitPrice: { currencyCode: "USD", nanos: 10 },
      });
    expect(() => catalogRate(item, "h", NOW)).toThrow();
  });
  it("rejects unsupported families and invalid shape quantities", () => {
    expect(() => machineComponents("bogus-2", { cpu: 2, ram: 4 })).toThrow("Unsupported");
    expect(() => machineComponents("e2-standard-2", { cpu: 0, ram: 4 })).toThrow("Invalid");
  });
  it("keeps the credential only in a header and records source time separately", async () => {
    const doc = await generateCatalog("private-test-key", csv, machines, [REGION]);
    expect(doc.about.generated).toBe("2026-10-08T04:00:00.000Z");
    expect(doc.catalog.sources[0].source_vintage).toBe("2026-10-08T00:00:00.000Z");
    expect(doc.catalog.sources[0].retrieved_at).toBe("2026-10-08T04:00:00.000Z");
    expect(doc.catalog.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).not.toContain("private-test-key");
      expect(init.headers).toEqual({ "x-goog-api-key": "private-test-key" });
      expect(init.redirect).toBe("error");
    }
    expect(JSON.stringify(doc)).not.toContain("private-test-key");
  });
  it("waits for all pages, including Cloud Storage, before generation", async () => {
    let page = 0;
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes("6F81")
              ? ++page === 1
                ? { skus: compute.slice(0, 2), nextPageToken: "next" }
                : { skus: compute.slice(2) }
              : { skus: buckets },
          ),
        ),
      ),
    );
    const doc = await generateCatalog("key", csv, machines, [REGION]);
    expect(doc.catalog.sources[0].pages).toBe(2);
    expect(doc.catalog.sources[0].sku_count).toBe(6);
    expect(fetchMock.mock.calls[1][0]).toContain("pageToken=next");
  });
  it("requires a credential without consulting an old public snapshot", async () => {
    await expect(generateCatalog("", csv, machines, [REGION])).rejects.toThrow("required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["403", "disconnect", "malformed", "empty", "repeated-token", "duplicate-sku"])(
    "does not generate after %s pagination",
    async (kind) => {
      let calls = 0;
      fetchMock.mockImplementation(() => {
        calls++;
        if (kind === "403")
          return Promise.resolve(new Response("secret should not be logged", { status: 403 }));
        if (kind === "disconnect" && calls > 1) return Promise.reject(new Error("disconnected"));
        if (kind === "malformed") return Promise.resolve(new Response("{}"));
        if (kind === "empty") return Promise.resolve(new Response('{"skus":[]}'));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              skus:
                kind === "repeated-token" && calls > 1 ? [sku("unmapped-but-distinct")] : compute,
              nextPageToken: "next",
            }),
          ),
        );
      });
      await expect(generateCatalog("key", csv, machines, [REGION])).rejects.toThrow();
    },
  );
});
