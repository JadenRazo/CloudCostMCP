#!/usr/bin/env tsx
/**
 * refresh-pricing.ts — Fetches current pricing from cloud provider public APIs
 * and updates the bundled GCP pricing data.
 *
 * Usage: npx tsx scripts/refresh-pricing.ts
 *
 * Data sources:
 *   - AWS:   Bulk Pricing CSV API (no auth required)
 *   - Azure: Retail Prices REST API (no auth required)
 *   - GCP:   Public pricing JSON from gstatic.com (no auth required)
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data/gcp-pricing");

// ---------------------------------------------------------------------------
// GCP pricing — fetches from the public gstatic endpoint
// ---------------------------------------------------------------------------

const GCP_PRICING_URL = "https://www.gstatic.com/cloud-site-ux/pricing/data/gcp-compute.json";

interface GcpSkuData {
  regions: Record<string, { price: Array<{ val: number; nanos: number; currency: string }> }>;
}

// Machine type definitions: family → { name: (vcpus, memGB) }
const MACHINE_TYPES: Record<string, Record<string, [number, number]>> = {
  e2: {
    "e2-micro": [0.25, 1], "e2-small": [0.5, 2], "e2-medium": [1, 4],
    "e2-standard-2": [2, 8], "e2-standard-4": [4, 16], "e2-standard-8": [8, 32],
    "e2-standard-16": [16, 64],
    "e2-highcpu-2": [2, 2], "e2-highcpu-4": [4, 4], "e2-highcpu-8": [8, 8],
    "e2-highmem-2": [2, 16], "e2-highmem-4": [4, 32], "e2-highmem-8": [8, 64],
  },
  n2: {
    "n2-standard-2": [2, 8], "n2-standard-4": [4, 16], "n2-standard-8": [8, 32],
    "n2-standard-16": [16, 64], "n2-standard-32": [32, 128],
    "n2-highcpu-2": [2, 2], "n2-highcpu-4": [4, 4], "n2-highcpu-8": [8, 8],
    "n2-highmem-2": [2, 16], "n2-highmem-4": [4, 32], "n2-highmem-8": [8, 64],
  },
  n2d: {
    "n2d-standard-2": [2, 8], "n2d-standard-4": [4, 16], "n2d-standard-8": [8, 32],
    "n2d-standard-16": [16, 64],
    "n2d-highcpu-2": [2, 2], "n2d-highcpu-4": [4, 4],
    "n2d-highmem-2": [2, 16], "n2d-highmem-4": [4, 32],
  },
  c2: {
    "c2-standard-4": [4, 16], "c2-standard-8": [8, 32], "c2-standard-16": [16, 64],
    "c2-standard-30": [30, 120], "c2-standard-60": [60, 240],
  },
  c3: {
    "c3-standard-4": [4, 16], "c3-standard-8": [8, 32], "c3-standard-22": [22, 88],
    "c3-highcpu-4": [4, 4], "c3-highcpu-8": [8, 8], "c3-highcpu-22": [22, 22],
    "c3-highmem-4": [4, 32], "c3-highmem-8": [8, 64], "c3-highmem-22": [22, 176],
  },
  c4: {
    "c4-standard-4": [4, 16], "c4-standard-8": [8, 32], "c4-standard-16": [16, 64],
    "c4-highcpu-4": [4, 4], "c4-highcpu-8": [8, 8],
    "c4-highmem-4": [4, 32], "c4-highmem-8": [8, 64],
  },
  n4: {
    "n4-standard-2": [2, 8], "n4-standard-4": [4, 16], "n4-standard-8": [8, 32],
    "n4-standard-16": [16, 64], "n4-standard-32": [32, 128],
    "n4-highcpu-2": [2, 2], "n4-highcpu-4": [4, 4], "n4-highcpu-8": [8, 8],
    "n4-highmem-2": [2, 16], "n4-highmem-4": [4, 32], "n4-highmem-8": [8, 64],
  },
  t2d: {
    "t2d-standard-1": [1, 4], "t2d-standard-2": [2, 8], "t2d-standard-4": [4, 16],
    "t2d-standard-8": [8, 32], "t2d-standard-16": [16, 64],
  },
};

const GCP_REGIONS = [
  "us-central1", "us-east1", "us-east4", "us-west1", "us-west4",
  "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-north1",
  "asia-southeast1", "asia-east1", "asia-northeast1", "asia-south1",
  "australia-southeast1", "southamerica-east1", "northamerica-northeast1",
];

function getStandardPrice(familyGroup: Record<string, GcpSkuData>, region: string): number | null {
  for (const [skuName, skuData] of Object.entries(familyGroup)) {
    if (skuName.toLowerCase().includes("custom") || skuName.toLowerCase().includes("sole")) continue;
    const rdata = skuData.regions?.[region];
    if (rdata?.price?.[0]) {
      const p = rdata.price[0];
      return (p.val ?? 0) + (p.nanos ?? 0) / 1e9;
    }
  }
  return null;
}

async function refreshGcpComputePricing(): Promise<void> {
  console.log("Fetching GCP compute pricing from gstatic.com...");
  const resp = await fetch(GCP_PRICING_URL);
  if (!resp.ok) throw new Error(`GCP pricing fetch failed: ${resp.status}`);

  const data = (await resp.json()) as {
    gcp: { compute: { gce: { vms_on_demand: Record<string, Record<string, GcpSkuData>> } } };
  };
  const vms = data.gcp.compute.gce.vms_on_demand;
  const cores = vms["cores:_per_core"] ?? {};
  const memory = vms["memory:_per_gb"] ?? {};

  // Load existing file for diff comparison
  const existingPath = resolve(DATA_DIR, "compute-engine.json");
  const existing: Record<string, Record<string, number>> = JSON.parse(
    readFileSync(existingPath, "utf-8"),
  );

  const result: Record<string, Record<string, number>> = {};
  let newTypes = 0;
  let priceChanges = 0;

  for (const region of GCP_REGIONS) {
    result[region] = {};

    // Preserve existing types we can't compute from per-core data (e.g. c2d)
    if (existing[region]) {
      Object.assign(result[region], existing[region]);
    }

    for (const [family, types] of Object.entries(MACHINE_TYPES)) {
      const corePrice = getStandardPrice(
        (cores[family] as unknown as Record<string, GcpSkuData>) ?? {},
        region,
      );
      const memPrice = getStandardPrice(
        (memory[family] as unknown as Record<string, GcpSkuData>) ?? {},
        region,
      );
      if (corePrice == null || memPrice == null) continue;

      for (const [mtype, [vcpus, memGb]] of Object.entries(types)) {
        const hourly = Math.round((vcpus * corePrice + memGb * memPrice) * 10000) / 10000;
        const oldPrice = result[region][mtype];
        if (oldPrice === undefined) newTypes++;
        else if (oldPrice !== hourly) priceChanges++;
        result[region][mtype] = hourly;
      }
    }
  }

  writeFileSync(existingPath, JSON.stringify(result, null, 2) + "\n");

  // Update metadata
  const metaPath = resolve(DATA_DIR, "metadata.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  meta.last_updated = new Date().toISOString().split("T")[0];
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log(`  Updated compute-engine.json: ${priceChanges} price changes, ${newTypes} new types`);
  console.log(`  Regions: ${GCP_REGIONS.length}, Machine types per region: ~${Object.keys(result["us-central1"] ?? {}).length}`);
}

// ---------------------------------------------------------------------------
// AWS pricing — samples from the Bulk Pricing CSV
// ---------------------------------------------------------------------------

async function checkAwsPricing(): Promise<void> {
  console.log("\nChecking AWS Bulk Pricing API...");
  try {
    const indexResp = await fetch(
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json",
    );
    if (!indexResp.ok) {
      console.log("  WARNING: AWS pricing index unreachable");
      return;
    }
    const index = (await indexResp.json()) as { publicationDate: string };
    console.log(`  AWS pricing index OK — publication date: ${index.publicationDate}`);
    console.log("  Live CSV streaming will use current prices at runtime.");
    console.log("  Fallback table (src/pricing/aws/fallback-data.ts) should be reviewed manually.");
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Azure pricing — samples from the Retail Prices API
// ---------------------------------------------------------------------------

interface AzurePriceItem {
  armSkuName: string;
  retailPrice: number;
  unitPrice: number;
  effectiveStartDate: string;
}

async function checkAzurePricing(): Promise<void> {
  console.log("\nChecking Azure Retail Prices API...");
  const sampleVMs = ["Standard_D2s_v5", "Standard_E2s_v5", "Standard_B2s"];
  try {
    for (const vm of sampleVMs) {
      const url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and priceType eq 'Consumption' and armSkuName eq '${vm}'`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.log(`  WARNING: Azure API returned ${resp.status} for ${vm}`);
        continue;
      }
      const data = (await resp.json()) as { Items: AzurePriceItem[] };
      const linux = data.Items.find(
        (i: AzurePriceItem) =>
          !i.armSkuName.includes("Windows") &&
          i.unitPrice > 0 &&
          i.effectiveStartDate !== undefined,
      );
      if (linux) {
        console.log(
          `  ${vm}: $${linux.unitPrice}/hr (effective: ${linux.effectiveStartDate.split("T")[0]})`,
        );
      }
    }
    console.log("  Fallback table (src/pricing/azure/fallback-data.ts) should be reviewed manually.");
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`=== CloudCostMCP Pricing Refresh — ${new Date().toISOString().split("T")[0]} ===\n`);

  await refreshGcpComputePricing();
  await checkAwsPricing();
  await checkAzurePricing();

  console.log("\n=== Done ===");
  console.log("GCP bundled data updated automatically.");
  console.log("AWS/Azure fallback tables printed for manual review — edit source files if needed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
