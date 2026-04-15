#!/usr/bin/env tsx
/**
 * refresh-pricing.ts — Fetches current pricing from cloud provider public APIs
 * and updates bundled pricing data plus provider metadata files.
 *
 * Usage:
 *   npx tsx scripts/refresh-pricing.ts            # report-only (legacy)
 *   npx tsx scripts/refresh-pricing.ts --write    # rewrite fallback tables
 *
 * Data sources:
 *   - AWS:   Bulk Pricing CSV per-region (streamed, filtered to fallback SKUs)
 *   - Azure: Retail Prices REST API (per-SKU filtered queries)
 *   - GCP:   Public pricing JSON from gstatic.com
 *
 * On any fetch failure for a given SKU, the existing fallback value is
 * preserved. The script never blanks out entries. It is safe to run offline:
 * all network steps will gracefully degrade and leave data unchanged.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCsvLine } from "../src/pricing/aws/csv-parser.js";
import {
  EC2_BASE_PRICES,
  RDS_BASE_PRICES,
  EBS_BASE_PRICES,
} from "../src/pricing/aws/fallback-data.js";
import {
  VM_BASE_PRICES,
  DISK_BASE_PRICES,
  DB_BASE_PRICES,
} from "../src/pricing/azure/fallback-data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const GCP_DATA_DIR = resolve(PROJECT_ROOT, "data/gcp-pricing");
const AWS_DATA_DIR = resolve(PROJECT_ROOT, "data/aws-pricing");
const AZURE_DATA_DIR = resolve(PROJECT_ROOT, "data/azure-pricing");
const AWS_FALLBACK_PATH = resolve(PROJECT_ROOT, "src/pricing/aws/fallback-data.ts");
const AZURE_FALLBACK_PATH = resolve(PROJECT_ROOT, "src/pricing/azure/fallback-data.ts");

const WRITE_MODE = process.argv.includes("--write");
const REFRESH_SCRIPT_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Diff-summary helpers
// ---------------------------------------------------------------------------

type DiffAction = "ADD" | "CHG" | "KEEP";
interface DiffEntry {
  action: DiffAction;
  sku: string;
  before?: number;
  after: number;
  reason?: string;
}

function printDiff(label: string, entries: DiffEntry[]): void {
  const add = entries.filter((e) => e.action === "ADD").length;
  const chg = entries.filter((e) => e.action === "CHG").length;
  const keep = entries.filter((e) => e.action === "KEEP").length;
  console.log(`\n  ${label}: ${add} ADD, ${chg} CHG, ${keep} KEEP`);
  for (const e of entries) {
    if (e.action === "ADD") {
      console.log(`    [ADD]        ${e.sku} = ${e.after}`);
    } else if (e.action === "CHG") {
      const delta = e.before !== undefined ? ((e.after - e.before) / e.before) * 100 : 0;
      console.log(
        `    [CHG price]  ${e.sku} ${e.before} -> ${e.after}  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`,
      );
    } else if (e.action === "KEEP") {
      console.log(`    [KEEP stale] ${e.sku} = ${e.after}${e.reason ? `  (${e.reason})` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GCP pricing — fetches from the public gstatic endpoint
// ---------------------------------------------------------------------------

const GCP_PRICING_URL = "https://www.gstatic.com/cloud-site-ux/pricing/data/gcp-compute.json";

interface GcpSkuData {
  regions: Record<string, { price: Array<{ val: number; nanos: number; currency: string }> }>;
}

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
  let data: {
    gcp: { compute: { gce: { vms_on_demand: Record<string, Record<string, GcpSkuData>> } } };
  };
  try {
    const resp = await fetch(GCP_PRICING_URL);
    if (!resp.ok) throw new Error(`GCP pricing fetch failed: ${resp.status}`);
    data = (await resp.json()) as typeof data;
  } catch (err) {
    console.log(`  WARNING: GCP fetch failed, keeping existing data: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const vms = data.gcp.compute.gce.vms_on_demand;
  const cores = vms["cores:_per_core"] ?? {};
  const memory = vms["memory:_per_gb"] ?? {};

  const existingPath = resolve(GCP_DATA_DIR, "compute-engine.json");
  const existing: Record<string, Record<string, number>> = JSON.parse(
    readFileSync(existingPath, "utf-8"),
  );

  const result: Record<string, Record<string, number>> = {};
  let newTypes = 0;
  let priceChanges = 0;

  for (const region of GCP_REGIONS) {
    result[region] = {};
    if (existing[region]) Object.assign(result[region], existing[region]);

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

  if (WRITE_MODE) {
    writeFileSync(existingPath, JSON.stringify(result, null, 2) + "\n");
    const metaPath = resolve(GCP_DATA_DIR, "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.last_updated = new Date().toISOString().split("T")[0];
    meta.refresh_script_version = REFRESH_SCRIPT_VERSION;
    meta.sku_count = Object.values(result).reduce((n, r) => n + Object.keys(r).length, 0);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    console.log(`  Updated compute-engine.json: ${priceChanges} price changes, ${newTypes} new types`);
  } else {
    console.log(`  [report-only] Would update: ${priceChanges} price changes, ${newTypes} new types`);
  }
}

// ---------------------------------------------------------------------------
// AWS pricing — stream the per-region EC2 CSV, collecting only the SKUs
// already in the fallback table. A hard timeout ensures the script never
// stalls CI.
// ---------------------------------------------------------------------------

const AWS_BULK_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const AWS_REFRESH_REGION = "us-east-1";
const AWS_CSV_TIMEOUT_MS = 180_000;

/**
 * Stream the EC2 CSV for a region and return a map of instanceType -> Linux
 * on-demand hourly price. Returns an empty map on any failure.
 */
async function fetchAwsEc2Prices(region: string): Promise<Map<string, number>> {
  const url = `${AWS_BULK_BASE}/AmazonEC2/current/${region}/index.csv`;
  const prices = new Map<string, number>();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AWS_CSV_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) {
      console.log(`  WARNING: AWS EC2 CSV fetch returned ${res.status}`);
      return prices;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let leftover = "";
    let headerFound = false;
    let colInstanceType = -1;
    let colOS = -1;
    let colTenancy = -1;
    let colTermType = -1;
    let colCapacityStatus = -1;
    let colProductFamily = -1;
    let colPrice = -1;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = leftover + value;
      const lines = chunk.split("\n");
      leftover = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;

        if (!headerFound) {
          if (line.startsWith('"SKU"') || line.startsWith("SKU")) {
            const headers = parseCsvLine(line);
            for (let h = 0; h < headers.length; h++) {
              const n = headers[h]!.trim();
              if (n === "Instance Type") colInstanceType = h;
              else if (n === "Operating System") colOS = h;
              else if (n === "Tenancy") colTenancy = h;
              else if (n === "TermType") colTermType = h;
              else if (n === "Capacity Status") colCapacityStatus = h;
              else if (n === "Product Family") colProductFamily = h;
              else if (n === "PricePerUnit" || n === "Price Per Unit") colPrice = h;
            }
            if (colInstanceType === -1 || colOS === -1 || colPrice === -1) return prices;
            headerFound = true;
          }
          continue;
        }

        if (!line.includes("OnDemand") || !line.includes("Compute Instance")) continue;
        const fields = parseCsvLine(line);
        if (colProductFamily !== -1 && fields[colProductFamily] !== "Compute Instance") continue;
        if (colTenancy !== -1 && fields[colTenancy] !== "Shared") continue;
        if (colTermType !== -1 && fields[colTermType] !== "OnDemand") continue;
        if (colCapacityStatus !== -1 && fields[colCapacityStatus] !== "Used") continue;
        if ((fields[colOS] ?? "") !== "Linux") continue;

        const instanceType = fields[colInstanceType] ?? "";
        const rawPrice = fields[colPrice] ?? "";
        if (!instanceType || !rawPrice) continue;
        const p = parseFloat(rawPrice);
        if (!isFinite(p) || p <= 0) continue;

        // AWS publishes multiple Linux rows per instance type that differ by
        // "License Model" and "Pre Installed S/W" (SQL, etc.). The base
        // Linux/no-license row is always the cheapest, so min() extracts it
        // without needing to parse those extra columns.
        const existing = prices.get(instanceType);
        if (existing === undefined || p < existing) prices.set(instanceType, p);
      }
    }
  } catch (err) {
    console.log(`  WARNING: AWS EC2 CSV stream failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  return prices;
}

/**
 * Stream the per-region RDS CSV and return instance_type -> hourly price for
 * PostgreSQL Single-AZ. Returns empty map on failure.
 */
async function fetchAwsRdsPrices(region: string): Promise<Map<string, number>> {
  const url = `${AWS_BULK_BASE}/AmazonRDS/current/${region}/index.csv`;
  const prices = new Map<string, number>();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AWS_CSV_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) return prices;

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let leftover = "";
    let headerFound = false;
    let colInstanceType = -1;
    let colEngine = -1;
    let colDeployment = -1;
    let colTermType = -1;
    let colPrice = -1;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = leftover + value;
      const lines = chunk.split("\n");
      leftover = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        if (!headerFound) {
          if (line.startsWith('"SKU"') || line.startsWith("SKU")) {
            const headers = parseCsvLine(line);
            for (let h = 0; h < headers.length; h++) {
              const n = headers[h]!.trim();
              if (n === "Instance Type") colInstanceType = h;
              else if (n === "Database Engine") colEngine = h;
              else if (n === "Deployment Option") colDeployment = h;
              else if (n === "TermType") colTermType = h;
              else if (n === "PricePerUnit" || n === "Price Per Unit") colPrice = h;
            }
            if (colInstanceType === -1 || colPrice === -1) return prices;
            headerFound = true;
          }
          continue;
        }

        if (!line.includes("OnDemand")) continue;
        const fields = parseCsvLine(line);
        if (colTermType !== -1 && fields[colTermType] !== "OnDemand") continue;
        if (colEngine !== -1 && fields[colEngine] !== "PostgreSQL") continue;
        if (colDeployment !== -1 && fields[colDeployment] !== "Single-AZ") continue;

        const instanceType = fields[colInstanceType] ?? "";
        const p = parseFloat(fields[colPrice] ?? "");
        if (!instanceType || !isFinite(p) || p <= 0) continue;
        // Same min-reduction as EC2: pick the cheapest matching row to avoid
        // license/storage variants inflating the fallback table.
        const existing = prices.get(instanceType);
        if (existing === undefined || p < existing) prices.set(instanceType, p);
      }
    }
  } catch (err) {
    console.log(`  WARNING: AWS RDS CSV stream failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  return prices;
}

function roundPrice(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Build a fresh set of fallback maps for AWS by overlaying live prices on
 * existing values. Any SKU we cannot refresh is preserved as-is.
 */
async function refreshAwsFallback(): Promise<void> {
  console.log("\nRefreshing AWS fallback table from Bulk Pricing API...");
  const ec2Live = await fetchAwsEc2Prices(AWS_REFRESH_REGION);
  const rdsLive = await fetchAwsRdsPrices(AWS_REFRESH_REGION);

  const ec2Diff: DiffEntry[] = [];
  const rdsDiff: DiffEntry[] = [];

  const nextEc2: Record<string, number> = {};
  for (const [sku, oldPrice] of Object.entries(EC2_BASE_PRICES)) {
    const live = ec2Live.get(sku);
    if (live === undefined) {
      nextEc2[sku] = oldPrice;
      ec2Diff.push({ action: "KEEP", sku, after: oldPrice, reason: "no live data" });
    } else {
      const rounded = roundPrice(live);
      nextEc2[sku] = rounded;
      if (Math.abs(rounded - oldPrice) > 1e-6) {
        ec2Diff.push({ action: "CHG", sku, before: oldPrice, after: rounded });
      } else {
        ec2Diff.push({ action: "KEEP", sku, after: rounded, reason: "unchanged" });
      }
    }
  }

  const nextRds: Record<string, number> = {};
  for (const [sku, oldPrice] of Object.entries(RDS_BASE_PRICES)) {
    // RDS fallback uses "db." prefix; CSV uses same prefix in Instance Type column
    const live = rdsLive.get(sku);
    if (live === undefined) {
      nextRds[sku] = oldPrice;
      rdsDiff.push({ action: "KEEP", sku, after: oldPrice, reason: "no live data" });
    } else {
      const rounded = roundPrice(live);
      nextRds[sku] = rounded;
      if (Math.abs(rounded - oldPrice) > 1e-6) {
        rdsDiff.push({ action: "CHG", sku, before: oldPrice, after: rounded });
      } else {
        rdsDiff.push({ action: "KEEP", sku, after: rounded, reason: "unchanged" });
      }
    }
  }

  // EBS: we do not refresh automatically because pricing is fixed per volume
  // type and the CSV parsing shape differs. Preserved as-is.
  const nextEbs: Record<string, number> = { ...EBS_BASE_PRICES };

  printDiff("AWS EC2", ec2Diff);
  printDiff("AWS RDS", rdsDiff);

  if (!WRITE_MODE) {
    console.log("  [report-only] AWS fallback table not written (pass --write to persist).");
    return;
  }

  rewriteAwsFallbackFile(nextEc2, nextRds, nextEbs);
  writeProviderMetadata(AWS_DATA_DIR, {
    source: AWS_BULK_BASE,
    sku_count: Object.keys(nextEc2).length + Object.keys(nextRds).length + Object.keys(nextEbs).length,
  });
  console.log("  Wrote src/pricing/aws/fallback-data.ts and data/aws-pricing/metadata.json");
}

/**
 * Rewrite the EC2/RDS/EBS price maps in src/pricing/aws/fallback-data.ts in
 * place. Only the three exported const objects are replaced; the rest of the
 * file (ALB/NAT/EKS constants, region multiplier helper, size order array)
 * is preserved by surgical string splicing between anchor comments.
 */
function rewriteAwsFallbackFile(
  ec2: Record<string, number>,
  rds: Record<string, number>,
  ebs: Record<string, number>,
): void {
  const src = readFileSync(AWS_FALLBACK_PATH, "utf-8");
  const nextSrc = src
    .replace(
      /export const EC2_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("EC2_BASE_PRICES", ec2),
    )
    .replace(
      /export const RDS_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("RDS_BASE_PRICES", rds),
    )
    .replace(
      /export const EBS_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("EBS_BASE_PRICES", ebs),
    );
  writeFileSync(AWS_FALLBACK_PATH, nextSrc);
}

function formatConstBlock(name: string, map: Record<string, number>): string {
  // Identifier-safe keys emit unquoted; everything else is JSON-quoted. This
  // keeps diffs minimal against the original hand-edited files.
  const lines = Object.entries(map).map(([k, v]) => {
    const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
    const key = safe ? k : JSON.stringify(k);
    return `  ${key}: ${v},`;
  });
  return `export const ${name}: Record<string, number> = {\n${lines.join("\n")}\n};\n`;
}

// ---------------------------------------------------------------------------
// Azure pricing — filtered Retail Prices API
// ---------------------------------------------------------------------------

interface AzurePriceItem {
  armSkuName: string;
  retailPrice: number;
  unitPrice: number;
  productName: string;
  skuName: string;
  meterName: string;
  serviceName: string;
  effectiveStartDate?: string;
}

const AZURE_API = "https://prices.azure.com/api/retail/prices";
const AZURE_REGION = "eastus";

async function azureQuery(filter: string): Promise<AzurePriceItem[]> {
  try {
    const resp = await fetch(`${AZURE_API}?$filter=${encodeURIComponent(filter)}`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { Items: AzurePriceItem[] };
    return data.Items ?? [];
  } catch {
    return [];
  }
}

/**
 * Convert a fallback table key (e.g. standard_d2s_v5) to the ARM SKU name
 * Azure's API expects (Standard_D2s_v5). Azure SKU names are case-insensitive
 * at the API but the API still filters exact strings, so we preserve the
 * canonical mixed case.
 */
function vmKeyToArmSku(key: string): string {
  // standard_d2s_v5 -> Standard_D2s_v5
  // Rules: leading token is always "Standard"; version tokens (v<digit>,
  // t<digit>) stay lowercase; the family token upper-cases the first letter
  // but preserves size-suffix letters (e.g. d2s, nc4as). This matches Azure's
  // armSkuName casing exactly.
  return key
    .split("_")
    .map((part, i) => {
      if (i === 0) return "Standard";
      if (/^v\d+$/.test(part)) return part; // version suffix: v3, v5, v6
      if (/^t\d+$/.test(part)) return part; // GPU tier suffix: t4
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("_");
}

async function refreshAzureFallback(): Promise<void> {
  console.log("\nRefreshing Azure fallback table from Retail Prices API...");

  const vmDiff: DiffEntry[] = [];
  const nextVm: Record<string, number> = {};

  for (const [key, oldPrice] of Object.entries(VM_BASE_PRICES)) {
    const armSku = vmKeyToArmSku(key);
    const items = await azureQuery(
      `serviceName eq 'Virtual Machines' and armRegionName eq '${AZURE_REGION}' and priceType eq 'Consumption' and armSkuName eq '${armSku}'`,
    );
    // Prefer Linux (non-Windows) consumption price
    const linux = items.find(
      (i) =>
        !i.productName.includes("Windows") &&
        !i.skuName.includes("Windows") &&
        !i.meterName.includes("Low Priority") &&
        !i.meterName.includes("Spot") &&
        i.unitPrice > 0,
    );
    if (!linux) {
      nextVm[key] = oldPrice;
      vmDiff.push({ action: "KEEP", sku: key, after: oldPrice, reason: "no live data" });
      continue;
    }
    const rounded = roundPrice(linux.unitPrice);
    nextVm[key] = rounded;
    if (Math.abs(rounded - oldPrice) > 1e-6) {
      vmDiff.push({ action: "CHG", sku: key, before: oldPrice, after: rounded });
    } else {
      vmDiff.push({ action: "KEEP", sku: key, after: rounded, reason: "unchanged" });
    }
  }

  // Disk & DB maps: preserved as-is (meter shape differs from VM consumption
  // rows and would require separate mappings per SKU). Kept stable for now.
  const nextDisk: Record<string, number> = { ...DISK_BASE_PRICES };
  const nextDb: Record<string, number> = { ...DB_BASE_PRICES };

  printDiff("Azure VMs", vmDiff);

  if (!WRITE_MODE) {
    console.log("  [report-only] Azure fallback table not written (pass --write to persist).");
    return;
  }

  rewriteAzureFallbackFile(nextVm, nextDisk, nextDb);
  writeProviderMetadata(AZURE_DATA_DIR, {
    source: AZURE_API,
    sku_count: Object.keys(nextVm).length + Object.keys(nextDisk).length + Object.keys(nextDb).length,
  });
  console.log("  Wrote src/pricing/azure/fallback-data.ts and data/azure-pricing/metadata.json");
}

function rewriteAzureFallbackFile(
  vm: Record<string, number>,
  disk: Record<string, number>,
  db: Record<string, number>,
): void {
  const src = readFileSync(AZURE_FALLBACK_PATH, "utf-8");
  const nextSrc = src
    .replace(
      /export const VM_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("VM_BASE_PRICES", vm),
    )
    .replace(
      /export const DISK_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("DISK_BASE_PRICES", disk),
    )
    .replace(
      /export const DB_BASE_PRICES: Record<string, number> = \{[\s\S]*?\n\};\n/,
      formatConstBlock("DB_BASE_PRICES", db),
    );
  writeFileSync(AZURE_FALLBACK_PATH, nextSrc);
}

// ---------------------------------------------------------------------------
// Provider metadata writer
// ---------------------------------------------------------------------------

function writeProviderMetadata(
  dir: string,
  extra: { source: string; sku_count: number },
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta = {
    last_updated: new Date().toISOString().split("T")[0],
    source: extra.source,
    sku_count: extra.sku_count,
    refresh_script_version: REFRESH_SCRIPT_VERSION,
    currency: "USD",
    notes: "Written by scripts/refresh-pricing.ts --write",
  };
  writeFileSync(resolve(dir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`=== CloudCostMCP Pricing Refresh — ${new Date().toISOString().split("T")[0]} ===`);
  console.log(`Mode: ${WRITE_MODE ? "WRITE" : "report-only"}\n`);

  await refreshGcpComputePricing();
  await refreshAwsFallback();
  await refreshAzureFallback();

  console.log("\n=== Done ===");
  if (!WRITE_MODE) {
    console.log("Re-run with --write to persist changes.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
