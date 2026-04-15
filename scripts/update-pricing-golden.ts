#!/usr/bin/env tsx
/**
 * update-pricing-golden.ts — Regenerates test/fixtures/pricing-golden.json.
 *
 * For every (provider, SKU, region) combination already listed in the golden
 * file, fetches the current live price and writes a fresh range of +/- 5%
 * around that price. Entries whose upstream fetch returns null or 0 are left
 * untouched so we do not erase historical coverage during a transient outage.
 *
 * WHEN TO RUN THIS:
 *   This should only be run AFTER `scripts/refresh-pricing.ts` has confirmed a
 *   legitimate upstream price change. Running it blindly will mask real drift
 *   — the whole point of the golden file is to catch unexpected upstream
 *   movement, so rebuilding it is a conscious act, not an automatic one.
 *
 * Usage:
 *   RUN_INTEGRATION=1 npx tsx scripts/update-pricing-golden.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PricingCache } from "../src/pricing/cache.js";
import { AwsBulkLoader } from "../src/pricing/aws/bulk-loader.js";
import { AzureRetailClient } from "../src/pricing/azure/retail-client.js";
import { CloudBillingClient } from "../src/pricing/gcp/cloud-billing-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(__dirname, "../test/fixtures/pricing-golden.json");

const TOLERANCE = 0.05; // +/- 5% around the live price

interface GoldenRange {
  min: number;
  max: number;
}
interface GoldenFile {
  $comment?: string;
  recorded_at: string;
  aws: Record<string, Record<string, GoldenRange>>;
  azure: Record<string, Record<string, GoldenRange>>;
  gcp: Record<string, Record<string, GoldenRange>>;
}

const AWS_STORAGE = new Set(["gp3"]);
const AWS_DB = new Set(["db.m6g.large"]);
const GCP_STORAGE = new Set(["pd-ssd"]);

function widen(price: number): GoldenRange {
  return {
    min: Number((price * (1 - TOLERANCE)).toFixed(6)),
    max: Number((price * (1 + TOLERANCE)).toFixed(6)),
  };
}

async function main(): Promise<void> {
  if (process.env.RUN_INTEGRATION !== "1") {
    // eslint-disable-next-line no-console
    console.error("Refusing to run without RUN_INTEGRATION=1 — this hits live provider APIs.");
    process.exit(1);
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as GoldenFile;
  const dbDir = join(tmpdir(), `cloudcost-golden-${Date.now()}`);
  const cache = new PricingCache(join(dbDir, "cache.db"));

  const aws = new AwsBulkLoader(cache);
  const azure = new AzureRetailClient(cache);
  const gcp = new CloudBillingClient(cache);

  let updated = 0;
  let preserved = 0;

  for (const [sku, regions] of Object.entries(golden.aws)) {
    for (const region of Object.keys(regions)) {
      let res;
      if (AWS_STORAGE.has(sku)) res = await aws.getStoragePrice(sku, region);
      else if (AWS_DB.has(sku)) res = await aws.getDatabasePrice(sku, region, "MySQL");
      else res = await aws.getComputePrice(sku, region, "Linux");
      const price = res?.price_per_unit;
      if (price && price > 0) {
        golden.aws[sku][region] = widen(price);
        updated++;
      } else {
        preserved++;
      }
    }
  }

  for (const [sku, regions] of Object.entries(golden.azure)) {
    for (const region of Object.keys(regions)) {
      const res = await azure.getComputePrice(sku, region, "linux");
      const price = res?.price_per_unit;
      if (price && price > 0) {
        golden.azure[sku][region] = widen(price);
        updated++;
      } else {
        preserved++;
      }
    }
  }

  for (const [sku, regions] of Object.entries(golden.gcp)) {
    for (const region of Object.keys(regions)) {
      const res = GCP_STORAGE.has(sku)
        ? await gcp.fetchStorageSkus(sku, region)
        : await gcp.fetchComputeSkus(sku, region);
      const price = res?.price_per_unit;
      if (price && price > 0) {
        golden.gcp[sku][region] = widen(price);
        updated++;
      } else {
        preserved++;
      }
    }
  }

  golden.recorded_at = new Date().toISOString().slice(0, 10);
  writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n", "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    `Golden file updated. Rewrote ${updated} entries, preserved ${preserved} existing entries that had no live data.`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("update-pricing-golden failed:", err);
  process.exit(1);
});
