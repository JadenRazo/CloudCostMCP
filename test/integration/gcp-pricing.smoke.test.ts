/** Daily authenticated check of the exact generator used by Refresh Pricing. */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateCatalog,
  type CatalogDocument,
  type MachineDefinition,
} from "../../src/pricing/gcp/catalog.js";
import {
  getGcpComputePricing,
  getGcpStoragePricing,
  getGcpDiskPricing,
} from "../../src/data/loader.js";
import { GATE_MAX_AGE_DAYS, MS_PER_DAY } from "../../src/data/freshness.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("GCP pricing source smoke", () => {
  let doc: CatalogDocument;
  beforeAll(async () => {
    const machines = JSON.parse(readFileSync("scripts/gcp/machines.json", "utf8")) as Record<
      string,
      MachineDefinition
    >;
    const regions = JSON.parse(readFileSync("data/region-price-multipliers.json", "utf8")) as {
      gcp: Record<string, number>;
    };
    doc = await generateCatalog(
      process.env.GCP_PRICING_API_KEY ?? "",
      readFileSync("scripts/gcp/mapping.csv", "utf8"),
      machines,
      Object.keys(regions.gcp),
    );
  }, 660_000);

  it("completes authenticated pagination of both official catalog services", () => {
    expect(doc.catalog.sources).toHaveLength(2);
    for (const source of doc.catalog.sources) {
      expect(source.pages).toBeGreaterThan(0);
      expect(source.sku_count).toBeGreaterThan(0);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("generates a genuinely recent snapshot after complete retrieval", () => {
    const ageDays = Math.floor((Date.now() - doc.about.timestamp * 1000) / MS_PER_DAY);
    expect(ageDays).toBeGreaterThanOrEqual(0);
    expect(ageDays).toBeLessThanOrEqual(GATE_MAX_AGE_DAYS);
  });

  it.each(["e2-standard-2", "c3-standard-4", "c4-standard-4", "a2-highgpu-1g", "a2-ultragpu-1g"])(
    "the bundled whole-instance %s price agrees with the official catalog",
    (machine) => {
      const bundled = getGcpComputePricing()["us-central1"]?.[machine];
      const live = doc.compute.instance[machine]?.cost["us-central1"]?.hour;
      expect(typeof bundled).toBe("number");
      expect(typeof live).toBe("number");
      expect(live).toBeGreaterThan(0);
      expect(Math.abs(bundled! - live!) / live!).toBeLessThan(0.15);
    },
  );

  it("bundled SSD and Cloud Storage rates agree with the official catalog", () => {
    const disk = getGcpDiskPricing()["us-central1"]?.["pd-ssd"];
    const liveDisk = doc.compute.storage.ssd.cost["us-central1"]?.month;
    const bucket = getGcpStoragePricing()["us-central1"]?.STANDARD;
    const liveBucket = doc.storage.bucket.standard.cost["us-central1"]?.month;
    expect(typeof liveDisk).toBe("number");
    expect(typeof liveBucket).toBe("number");
    expect(Math.abs(disk! - liveDisk!) / liveDisk!).toBeLessThan(0.15);
    expect(Math.abs(bucket! - liveBucket!) / liveBucket!).toBeLessThan(0.15);
  });
});
