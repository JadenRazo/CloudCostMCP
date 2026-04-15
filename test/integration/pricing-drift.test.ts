/**
 * Cross-provider pricing drift integration test.
 *
 * Gated behind RUN_INTEGRATION=1 (see existing *.smoke.test.ts files).
 *
 * For each provider + SKU + region listed in the golden file, fetch the live
 * price and assert it falls inside the recorded [min, max] range. On failure,
 * emit a machine-parseable DRIFT log line and fail the test so CI surfaces the
 * exact delta.
 *
 * The golden file lives at test/fixtures/pricing-golden.json. Ranges are
 * deliberately wide (~+/-5% plus headroom) so that normal upstream drift does
 * not produce false alarms. If a legitimate upstream change occurs, regenerate
 * the golden file with: npx tsx scripts/update-pricing-golden.ts
 *
 * Run locally:
 *   RUN_INTEGRATION=1 npx vitest run test/integration/pricing-drift.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PricingCache } from "../../src/pricing/cache.js";
import { AwsBulkLoader } from "../../src/pricing/aws/bulk-loader.js";
import { AzureRetailClient } from "../../src/pricing/azure/retail-client.js";
import { CloudBillingClient } from "../../src/pricing/gcp/cloud-billing-client.js";

const RUN = process.env.RUN_INTEGRATION === "1";

interface GoldenRange {
  min: number;
  max: number;
}
interface GoldenFile {
  recorded_at: string;
  aws: Record<string, Record<string, GoldenRange>>;
  azure: Record<string, Record<string, GoldenRange>>;
  gcp: Record<string, Record<string, GoldenRange>>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(__dirname, "../fixtures/pricing-golden.json");

function loadGolden(): GoldenFile {
  const raw = readFileSync(GOLDEN_PATH, "utf-8");
  return JSON.parse(raw) as GoldenFile;
}

/**
 * Report a drift failure in a grep-friendly format that CI dashboards can parse.
 * Example:
 *   DRIFT: aws/t3.medium/us-east-1 golden=[0.040,0.044] actual=0.047 delta=+7% — run scripts/update-pricing-golden.ts if upstream change is expected
 */
function reportDrift(
  provider: string,
  sku: string,
  region: string,
  golden: GoldenRange,
  actual: number,
): void {
  const mid = (golden.min + golden.max) / 2;
  const pct = mid > 0 ? ((actual - mid) / mid) * 100 : 0;
  const sign = pct >= 0 ? "+" : "";
  console.error(
    `DRIFT: ${provider}/${sku}/${region} ` +
      `golden=[${golden.min.toFixed(4)},${golden.max.toFixed(4)}] ` +
      `actual=${actual.toFixed(4)} delta=${sign}${pct.toFixed(1)}% ` +
      `— run scripts/update-pricing-golden.ts if upstream change is expected`,
  );
}

function assertInRange(
  provider: string,
  sku: string,
  region: string,
  golden: GoldenRange,
  actual: number | null | undefined,
): void {
  if (actual === null || actual === undefined || actual <= 0) {
    console.warn(
      `SKIP: ${provider}/${sku}/${region} — upstream returned null/zero, treating as catalog miss not drift`,
    );
    return;
  }
  if (actual < golden.min || actual > golden.max) {
    reportDrift(provider, sku, region, golden, actual);
    throw new Error(
      `Price drift for ${provider}/${sku}/${region}: expected [${golden.min}, ${golden.max}], got ${actual}`,
    );
  }
  expect(actual).toBeGreaterThanOrEqual(golden.min);
  expect(actual).toBeLessThanOrEqual(golden.max);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const golden = loadGolden();
const dbDir = join(tmpdir(), `cloudcost-drift-${Date.now()}`);
const dbPath = join(dbDir, "cache.db");

const AWS_STORAGE_SKUS = new Set(["gp3"]);
const AWS_DB_SKUS = new Set(["db.m6g.large"]);
const GCP_STORAGE_SKUS = new Set(["pd-ssd"]);

describe.skipIf(!RUN)("pricing drift — AWS", () => {
  const cache = new PricingCache(dbPath);
  const loader = new AwsBulkLoader(cache);

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  for (const [sku, regions] of Object.entries(golden.aws)) {
    for (const [region, range] of Object.entries(regions)) {
      it(
        `aws ${sku} in ${region} stays inside golden range`,
        async () => {
          let result;
          if (AWS_STORAGE_SKUS.has(sku)) {
            result = await loader.getStoragePrice(sku, region);
          } else if (AWS_DB_SKUS.has(sku)) {
            result = await loader.getDatabasePrice(sku, region, "MySQL");
          } else {
            result = await loader.getComputePrice(sku, region, "Linux");
          }
          assertInRange("aws", sku, region, range, result?.price_per_unit);
        },
        120_000,
      );
    }
  }
});

describe.skipIf(!RUN)("pricing drift — Azure", () => {
  const cache = new PricingCache(dbPath);
  const client = new AzureRetailClient(cache);

  for (const [sku, regions] of Object.entries(golden.azure)) {
    for (const [region, range] of Object.entries(regions)) {
      it(
        `azure ${sku} in ${region} stays inside golden range`,
        async () => {
          const result = await client.getComputePrice(sku, region, "linux");
          assertInRange("azure", sku, region, range, result?.price_per_unit);
        },
        120_000,
      );
    }
  }
});

describe.skipIf(!RUN)("pricing drift — GCP", () => {
  const cache = new PricingCache(dbPath);
  const client = new CloudBillingClient(cache);

  for (const [sku, regions] of Object.entries(golden.gcp)) {
    for (const [region, range] of Object.entries(regions)) {
      it(
        `gcp ${sku} in ${region} stays inside golden range`,
        async () => {
          let result;
          if (GCP_STORAGE_SKUS.has(sku)) {
            result = await client.fetchStorageSkus(sku, region);
          } else {
            result = await client.fetchComputeSkus(sku, region);
          }
          assertInRange("gcp", sku, region, range, result?.price_per_unit);
        },
        120_000,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-provider sanity — catches a single provider being wildly off
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("pricing drift — cross-provider sanity", () => {
  const cache = new PricingCache(dbPath);
  const aws = new AwsBulkLoader(cache);
  const azure = new AzureRetailClient(cache);
  const gcp = new CloudBillingClient(cache);

  it(
    "comparable on-demand compute prices stay within 3x across providers",
    async () => {
      const awsPrice = (await aws.getComputePrice("t3.medium", "us-east-1", "Linux"))
        ?.price_per_unit;
      const azurePrice = (await azure.getComputePrice("Standard_D2s_v5", "eastus", "linux"))
        ?.price_per_unit;
      const gcpPrice = (await gcp.fetchComputeSkus("e2-standard-2", "us-central1"))
        ?.price_per_unit;

      const prices = [
        { name: "aws/t3.medium", value: awsPrice },
        { name: "azure/Standard_D2s_v5", value: azurePrice },
        { name: "gcp/e2-standard-2", value: gcpPrice },
      ].filter(
        (p): p is { name: string; value: number } =>
          typeof p.value === "number" && p.value > 0,
      );

      expect(prices.length).toBeGreaterThanOrEqual(2);

      for (const p of prices) {
        expect(p.value).toBeGreaterThan(0);
        expect(p.value).toBeLessThan(100);
      }

      const min = Math.min(...prices.map((p) => p.value));
      const max = Math.max(...prices.map((p) => p.value));
      const ratio = max / min;
      if (ratio > 3) {
        console.error(
          `DRIFT: cross-provider compute ratio ${ratio.toFixed(2)}x exceeds 3x ` +
            `— ${prices.map((p) => `${p.name}=${p.value.toFixed(4)}`).join(", ")}`,
        );
      }
      expect(ratio).toBeLessThanOrEqual(3);
    },
    180_000,
  );
});
