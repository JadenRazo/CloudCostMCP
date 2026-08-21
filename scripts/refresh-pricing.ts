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
 *   - GCP:   gcosts pricing.yml (weekly snapshot of the Cloud Billing Catalog)
 *
 * On any fetch failure for a given SKU, the existing fallback value is
 * preserved. The script never blanks out entries. Per-SKU misses degrade
 * gracefully, but a provider-level fetch failure (endpoint gone, network
 * down) is reported at the end and makes the script exit non-zero so stale
 * data is never silently kept — successful providers are still written.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

import { parseCsvLine } from "../src/pricing/aws/csv-parser.js";
import { fetchWithRetry } from "../src/pricing/fetch-utils.js";
import { GCP_PRICING_SOURCE_URL } from "../src/data/pricing-sources.js";
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
const REFRESH_SCRIPT_VERSION = "3.0.0";

/**
 * Provider-level refresh failures collected during the run. A non-empty list
 * makes the script exit non-zero after all providers have been attempted, so
 * a broken upstream is loud in CI instead of silently leaving stale data —
 * while still letting the other providers' refreshes complete and be
 * committed.
 */
const refreshFailures: string[] = [];

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

/**
 * Refuse to certify a provider whose upstream returned (almost) nothing.
 *
 * AWS and Azure used to log a WARNING and carry on: their fetch helpers return
 * an empty map on failure, every SKU then falls through to "no live data", and
 * the metadata was stamped with today's date regardless. A dead AWS upstream
 * would have rotted exactly the way GCP's did — except silently, with no failed
 * run and no issue filed. GCP was only ever loud because its fetcher happened
 * to return early, before the stamp.
 *
 * Returns true when coverage is good enough to write.
 */
function assertLiveCoverage(label: string, live: number, total: number, source: string): boolean {
  const floor = Math.ceil(total * 0.8);
  if (total === 0 || live >= floor) return true;
  const message =
    `only ${live} of ${total} SKUs returned live data (floor ${floor}) — the upstream is ` +
    `unreachable or its response shape changed`;
  console.error(`  ERROR: ${label} refresh failed — ${message}`);
  refreshFailures.push(`${label}: ${message} (URL: ${source})`);
  return false;
}

// ---------------------------------------------------------------------------
// GCP pricing — sourced from the gcosts dataset
//
// Google retired every key-free bulk pricing source. The gstatic asset this
// script used to read (cloud-site-ux/pricing/data/gcp-compute.json) has
// returned 404 since before the first scheduled run on 2026-04-20, and
// cloudbilling.googleapis.com/v1 answers unregistered callers with 403. The
// result was four months of weekly failures against a GCP dataset frozen at its
// 2026-04-15 vintage, shipped to every npm consumer.
//
// gcosts (Cyclenerd/google-cloud-pricing-cost-calculator, Apache-2.0) publishes
// a pricing.yml regenerated weekly from the official Cloud Billing Catalog API.
// Two properties matter here beyond "it responds":
//
//   - It ships assembled per-instance hourly rates. The old
//     `vcpus * corePrice + memGb * memPrice` reconstruction is gone, and with it
//     a class of derivation error that no test could have caught.
//   - It carries an `about.generated` stamp, so the vintage we record is the
//     data's own rather than the date we happened to run. That distinction is
//     what makes `last_updated` mean something again.
// ---------------------------------------------------------------------------

const GCP_PRICING_URL = GCP_PRICING_SOURCE_URL;

const GCP_SOURCE_LABEL =
  "gcosts pricing.yml (Cyclenerd/google-cloud-pricing-cost-calculator, Apache-2.0), " +
  "generated from the Google Cloud Billing Catalog API";

/** Bundled persistent-disk type -> gcosts `compute.storage` key. */
const GCP_DISK_TYPES: Record<string, string> = {
  "pd-standard": "hdd",
  "pd-ssd": "ssd",
  "pd-balanced": "balanced",
  "pd-extreme": "extreme",
};

/** Bundled Cloud Storage class -> gcosts `storage.bucket` key. */
const GCP_STORAGE_CLASSES: Record<string, string> = {
  STANDARD: "standard",
  NEARLINE: "nearline",
  COLDLINE: "coldline",
  ARCHIVE: "archiv",
};

/**
 * Datasets under data/gcp-pricing/ that gcosts does not cover and that no
 * automation refreshes. Declared here so they are reported rather than silently
 * re-certified as fresh by the automated stamp — which is what used to happen.
 */
const GCP_CURATED_DATASETS = ["cloud-sql.json"] as const;

const MACHINE_TYPES: Record<string, Record<string, [number, number]>> = {
  e2: {
    "e2-micro": [0.25, 1],
    "e2-small": [0.5, 2],
    "e2-medium": [1, 4],
    "e2-standard-2": [2, 8],
    "e2-standard-4": [4, 16],
    "e2-standard-8": [8, 32],
    "e2-standard-16": [16, 64],
    "e2-highcpu-2": [2, 2],
    "e2-highcpu-4": [4, 4],
    "e2-highcpu-8": [8, 8],
    "e2-highmem-2": [2, 16],
    "e2-highmem-4": [4, 32],
    "e2-highmem-8": [8, 64],
  },
  n2: {
    "n2-standard-2": [2, 8],
    "n2-standard-4": [4, 16],
    "n2-standard-8": [8, 32],
    "n2-standard-16": [16, 64],
    "n2-standard-32": [32, 128],
    "n2-highcpu-2": [2, 2],
    "n2-highcpu-4": [4, 4],
    "n2-highcpu-8": [8, 8],
    "n2-highmem-2": [2, 16],
    "n2-highmem-4": [4, 32],
    "n2-highmem-8": [8, 64],
  },
  n2d: {
    "n2d-standard-2": [2, 8],
    "n2d-standard-4": [4, 16],
    "n2d-standard-8": [8, 32],
    "n2d-standard-16": [16, 64],
    "n2d-highcpu-2": [2, 2],
    "n2d-highcpu-4": [4, 4],
    "n2d-highmem-2": [2, 16],
    "n2d-highmem-4": [4, 32],
  },
  c2: {
    "c2-standard-4": [4, 16],
    "c2-standard-8": [8, 32],
    "c2-standard-16": [16, 64],
    "c2-standard-30": [30, 120],
    "c2-standard-60": [60, 240],
  },
  c2d: {
    "c2d-standard-4": [4, 16],
    "c2d-standard-8": [8, 32],
  },
  // GPU instances. The source prices these whole (accelerator included), which
  // is why they can be listed here at all: the old per-core/per-GB
  // reconstruction had no way to express an attached A100.
  a2: {
    "a2-highgpu-1g": [12, 85],
    "a2-highgpu-2g": [24, 170],
    "a2-highgpu-4g": [48, 340],
    "a2-highgpu-8g": [96, 680],
    "a2-megagpu-16g": [96, 1360],
    "a2-ultragpu-1g": [12, 170],
    "a2-ultragpu-2g": [24, 340],
    "a2-ultragpu-4g": [48, 680],
    "a2-ultragpu-8g": [96, 1360],
  },
  c3: {
    "c3-standard-4": [4, 16],
    "c3-standard-8": [8, 32],
    "c3-standard-22": [22, 88],
    "c3-highcpu-4": [4, 4],
    "c3-highcpu-8": [8, 8],
    "c3-highcpu-22": [22, 22],
    "c3-highmem-4": [4, 32],
    "c3-highmem-8": [8, 64],
    "c3-highmem-22": [22, 176],
  },
  c4: {
    "c4-standard-4": [4, 16],
    "c4-standard-8": [8, 32],
    "c4-standard-16": [16, 64],
    "c4-highcpu-4": [4, 4],
    "c4-highcpu-8": [8, 8],
    "c4-highmem-4": [4, 32],
    "c4-highmem-8": [8, 64],
  },
  n4: {
    "n4-standard-2": [2, 8],
    "n4-standard-4": [4, 16],
    "n4-standard-8": [8, 32],
    "n4-standard-16": [16, 64],
    "n4-standard-32": [32, 128],
    "n4-highcpu-2": [2, 2],
    "n4-highcpu-4": [4, 4],
    "n4-highcpu-8": [8, 8],
    "n4-highmem-2": [2, 16],
    "n4-highmem-4": [4, 32],
    "n4-highmem-8": [8, 64],
  },
  t2d: {
    "t2d-standard-1": [1, 4],
    "t2d-standard-2": [2, 8],
    "t2d-standard-4": [4, 16],
    "t2d-standard-8": [8, 32],
    "t2d-standard-16": [16, 64],
  },
};

interface GcostsEntry {
  cost?: Record<string, { hour?: number; month?: number }>;
}

interface GcostsDoc {
  about?: { generated?: string; timestamp?: number };
  compute?: {
    instance?: Record<string, GcostsEntry>;
    storage?: Record<string, GcostsEntry>;
  };
  storage?: { bucket?: Record<string, GcostsEntry> };
}

/**
 * The regions the product already knows about. Using this list rather than a
 * hardcoded one means real prices replace the estimated multipliers in
 * data/region-price-multipliers.json wherever gcosts has them.
 */
function gcpRegions(): string[] {
  const raw = readFileSync(resolve(PROJECT_ROOT, "data/region-price-multipliers.json"), "utf-8");
  const parsed = JSON.parse(raw) as { gcp?: Record<string, number> };
  return Object.keys(parsed.gcp ?? {});
}

function gcostsPrice(
  entry: GcostsEntry | undefined,
  region: string,
  field: "hour" | "month",
): number | null {
  const value = entry?.cost?.[region]?.[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Bundled files carry 4dp. Rounding here keeps existing regions byte-identical. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * The dataset's own generation date as YYYY-MM-DD. Returns null when the stamp
 * is missing or unparseable — an unknown vintage is never silently replaced
 * with today's date, because that is precisely the lie that hid this outage.
 */
function gcostsVintage(doc: GcostsDoc): string | null {
  const ts = doc.about?.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return new Date(ts * 1000).toISOString().split("T")[0];
  }
  const generated = doc.about?.generated;
  if (typeof generated === "string") {
    const parsed = new Date(generated);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];
  }
  return null;
}

/**
 * Rebuild one `{region: {sku: price}}` file from a gcosts section.
 *
 * Existing values are preserved for any region/SKU the source does not cover,
 * so a partial upstream never blanks out a table.
 */
function buildGcpTable(
  fileName: string,
  regions: string[],
  skuMap: Record<string, string>,
  section: Record<string, GcostsEntry> | undefined,
  field: "hour" | "month",
): {
  table: Record<string, Record<string, number>>;
  matched: number;
  added: number;
  changed: number;
} {
  const filePath = resolve(GCP_DATA_DIR, fileName);
  const existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
    string,
    Record<string, number>
  >;

  const table: Record<string, Record<string, number>> = {};
  let matched = 0;
  let added = 0;
  let changed = 0;

  for (const region of regions) {
    const row: Record<string, number> = { ...(existing[region] ?? {}) };
    for (const [bundledName, sourceKey] of Object.entries(skuMap)) {
      const price = gcostsPrice(section?.[sourceKey], region, field);
      if (price === null) continue;
      const rounded = round4(price);
      const before = row[bundledName];
      if (before === undefined) added++;
      else if (before !== rounded) changed++;
      row[bundledName] = rounded;
      matched++;
    }
    if (Object.keys(row).length > 0) table[region] = row;
  }

  return { table, matched, added, changed };
}

async function refreshGcpPricing(): Promise<void> {
  console.log("Fetching GCP pricing from the gcosts dataset...");

  let doc: GcostsDoc;
  try {
    const resp = await fetchWithRetry(GCP_PRICING_URL);
    if (!resp.ok) throw new Error(`GCP pricing fetch failed: ${resp.status}`);
    doc = parseYaml(await resp.text()) as GcostsDoc;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: GCP pricing refresh failed — existing data is now stale: ${message}`);
    refreshFailures.push(`GCP: ${message} (URL: ${GCP_PRICING_URL})`);
    return;
  }

  const vintage = gcostsVintage(doc);
  if (vintage === null) {
    const message = "gcosts dataset carries no usable about.generated/about.timestamp";
    console.error(`  ERROR: ${message}`);
    refreshFailures.push(`GCP: ${message} (URL: ${GCP_PRICING_URL})`);
    return;
  }

  const regions = gcpRegions();
  const machineTypes: Record<string, string> = {};
  for (const family of Object.values(MACHINE_TYPES)) {
    for (const mtype of Object.keys(family)) machineTypes[mtype] = mtype;
  }

  const compute = buildGcpTable(
    "compute-engine.json",
    regions,
    machineTypes,
    doc.compute?.instance,
    "hour",
  );
  const disk = buildGcpTable(
    "persistent-disk.json",
    regions,
    GCP_DISK_TYPES,
    doc.compute?.storage,
    "month",
  );
  const storage = buildGcpTable(
    "cloud-storage.json",
    regions,
    GCP_STORAGE_CLASSES,
    doc.storage?.bucket,
    "month",
  );

  // Sanity floors. A fetch that succeeds but parses to nothing is the failure
  // mode a liveness check cannot see: `last_verified` would stay fresh while the
  // data rotted. Refuse to write, and be loud, rather than certify an empty
  // parse as a successful refresh.
  const floors: Array<[string, number, number]> = [
    ["compute-engine.json", compute.matched, 500],
    ["persistent-disk.json", disk.matched, 40],
    ["cloud-storage.json", storage.matched, 40],
  ];
  const breached = floors.filter(([, matched, floor]) => matched < floor);
  if (breached.length > 0) {
    const detail = breached.map(([f, m, floor]) => `${f}: ${m} < ${floor}`).join("; ");
    const message = `gcosts parsed but yielded too few prices (${detail}) — upstream shape likely changed`;
    console.error(`  ERROR: ${message}`);
    refreshFailures.push(`GCP: ${message} (URL: ${GCP_PRICING_URL})`);
    return;
  }

  console.log(`  gcosts vintage: ${vintage} (${regions.length} regions requested)`);
  console.log(
    `  compute-engine.json:  ${compute.matched} prices, ${compute.added} new, ${compute.changed} changed, ` +
      `${Object.keys(compute.table).length} regions`,
  );
  console.log(
    `  persistent-disk.json: ${disk.matched} prices, ${disk.added} new, ${disk.changed} changed, ` +
      `${Object.keys(disk.table).length} regions`,
  );
  console.log(
    `  cloud-storage.json:   ${storage.matched} prices, ${storage.added} new, ${storage.changed} changed, ` +
      `${Object.keys(storage.table).length} regions`,
  );
  for (const curated of GCP_CURATED_DATASETS) {
    console.log(`  ${curated}: not covered by the source — hand-curated, left untouched`);
  }

  if (!WRITE_MODE) {
    console.log("  [report-only] Would write compute-engine, persistent-disk, cloud-storage.");
    return;
  }

  const skuCount =
    Object.values(compute.table).reduce((n, r) => n + Object.keys(r).length, 0) +
    Object.values(disk.table).reduce((n, r) => n + Object.keys(r).length, 0) +
    Object.values(storage.table).reduce((n, r) => n + Object.keys(r).length, 0);

  for (const [name, built] of [
    ["compute-engine.json", compute],
    ["persistent-disk.json", disk],
    ["cloud-storage.json", storage],
  ] as const) {
    writeFileSync(resolve(GCP_DATA_DIR, name), JSON.stringify(built.table, null, 2) + "\n");
  }

  writeProviderMetadata(GCP_DATA_DIR, {
    source: GCP_SOURCE_LABEL,
    sku_count: skuCount,
    last_updated: vintage,
    curated_datasets: [...GCP_CURATED_DATASETS],
  });
  console.log(`  Wrote 3 GCP data files and data/gcp-pricing/metadata.json`);
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
    const res = await fetchWithRetry(
      url,
      { signal: controller.signal },
      { maxResponseBytes: Infinity },
    );
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
    console.log(
      `  WARNING: AWS EC2 CSV stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    const res = await fetchWithRetry(
      url,
      { signal: controller.signal },
      { maxResponseBytes: Infinity },
    );
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
    console.log(
      `  WARNING: AWS RDS CSV stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  const ec2Ok = assertLiveCoverage(
    "AWS EC2",
    ec2Diff.filter((e) => e.reason !== "no live data").length,
    ec2Diff.length,
    `${AWS_BULK_BASE}/AmazonEC2`,
  );
  const rdsOk = assertLiveCoverage(
    "AWS RDS",
    rdsDiff.filter((e) => e.reason !== "no live data").length,
    rdsDiff.length,
    `${AWS_BULK_BASE}/AmazonRDS`,
  );
  if (!ec2Ok || !rdsOk) {
    console.error("  AWS metadata not stamped — refusing to certify unverified data as fresh.");
    return;
  }

  if (!WRITE_MODE) {
    console.log("  [report-only] AWS fallback table not written (pass --write to persist).");
    return;
  }

  rewriteAwsFallbackFile(nextEc2, nextRds, nextEbs);
  writeProviderMetadata(AWS_DATA_DIR, {
    source: AWS_BULK_BASE,
    sku_count:
      Object.keys(nextEc2).length + Object.keys(nextRds).length + Object.keys(nextEbs).length,
    curated_datasets: ["EBS_BASE_PRICES (src/pricing/aws/fallback-data.ts)"],
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
  const original = readFileSync(AWS_FALLBACK_PATH, "utf-8");
  const nextSrc = original
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

  // Validate: re-import the rewritten module in a fresh subprocess to confirm
  // it still parses and exports the expected named bindings. If the regex
  // rewrite produced malformed TypeScript, restore the original and exit
  // non-zero so a bad refresh never gets committed.
  validateRewrittenModule(AWS_FALLBACK_PATH, original, [
    "EC2_BASE_PRICES",
    "RDS_BASE_PRICES",
    "EBS_BASE_PRICES",
  ]);
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
    const resp = await fetchWithRetry(`${AZURE_API}?$filter=${encodeURIComponent(filter)}`);
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

  if (
    !assertLiveCoverage(
      "Azure VMs",
      vmDiff.filter((e) => e.reason !== "no live data").length,
      vmDiff.length,
      AZURE_API,
    )
  ) {
    console.error("  Azure metadata not stamped — refusing to certify unverified data as fresh.");
    return;
  }

  if (!WRITE_MODE) {
    console.log("  [report-only] Azure fallback table not written (pass --write to persist).");
    return;
  }

  rewriteAzureFallbackFile(nextVm, nextDisk, nextDb);
  writeProviderMetadata(AZURE_DATA_DIR, {
    source: AZURE_API,
    sku_count:
      Object.keys(nextVm).length + Object.keys(nextDisk).length + Object.keys(nextDb).length,
    curated_datasets: [
      "DISK_BASE_PRICES (src/pricing/azure/fallback-data.ts)",
      "DB_BASE_PRICES (src/pricing/azure/fallback-data.ts)",
    ],
  });
  console.log("  Wrote src/pricing/azure/fallback-data.ts and data/azure-pricing/metadata.json");
}

function rewriteAzureFallbackFile(
  vm: Record<string, number>,
  disk: Record<string, number>,
  db: Record<string, number>,
): void {
  const original = readFileSync(AZURE_FALLBACK_PATH, "utf-8");
  const nextSrc = original
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

  validateRewrittenModule(AZURE_FALLBACK_PATH, original, [
    "VM_BASE_PRICES",
    "DISK_BASE_PRICES",
    "DB_BASE_PRICES",
  ]);
}

/**
 * Validate that a freshly-rewritten fallback-data module still compiles and
 * exports the expected named bindings by `import()`-ing it through a tsx
 * subprocess. If the import fails (parse error, missing export, etc.) the
 * original content is restored on disk and the script exits non-zero so the
 * bad refresh is never committed.
 */
function validateRewrittenModule(
  modulePath: string,
  originalContent: string,
  expectedExports: string[],
): void {
  const probe = `
    import(${JSON.stringify(modulePath)}).then((m) => {
      const missing = ${JSON.stringify(expectedExports)}.filter((k) => m[k] === undefined);
      if (missing.length > 0) {
        console.error("MISSING_EXPORTS:" + missing.join(","));
        process.exit(2);
      }
      process.exit(0);
    }).catch((err) => {
      console.error("IMPORT_FAILED:" + (err && err.stack ? err.stack : String(err)));
      process.exit(3);
    });
  `;

  const result = spawnSync("npx", ["--yes", "tsx", "--eval", probe], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    // Restore the pre-write content so the working tree is left clean.
    writeFileSync(modulePath, originalContent);
    console.error(
      `\nERROR: rewritten ${modulePath} failed to import; restoring original.\n` +
        `  stderr: ${result.stderr ?? ""}\n` +
        `  stdout: ${result.stdout ?? ""}`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Provider metadata writer
// ---------------------------------------------------------------------------

/**
 * Write a provider's metadata.json.
 *
 * Two dates, because one was doing the work of two and doing it badly:
 *
 *   last_updated  — the vintage of the numbers. For AWS and Azure the refresh
 *                   re-reads every SKU from the live API, so "today" genuinely
 *                   means "confirmed against upstream today". For GCP the source
 *                   is a weekly snapshot that carries its own generation stamp,
 *                   so we record that stamp instead of pretending we checked.
 *   last_verified — the last time the refresh loop completed for this provider.
 *
 * `curated_datasets` names files in the directory that no automation touches.
 * They used to be silently re-certified as fresh by this stamp; naming them
 * makes the gap visible to check-freshness.ts instead.
 */
function writeProviderMetadata(
  dir: string,
  extra: {
    source: string;
    sku_count: number;
    last_updated?: string;
    curated_datasets?: string[];
  },
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().split("T")[0];
  const curated = extra.curated_datasets ?? [];
  const meta = {
    last_updated: extra.last_updated ?? today,
    last_verified: today,
    refresh_policy: "automated",
    source: extra.source,
    sku_count: extra.sku_count,
    refresh_script_version: REFRESH_SCRIPT_VERSION,
    currency: "USD",
    ...(curated.length > 0 ? { curated_datasets: curated } : {}),
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

  await refreshGcpPricing();
  await refreshAwsFallback();
  await refreshAzureFallback();

  console.log("\n=== Done ===");
  if (!WRITE_MODE) {
    console.log("Re-run with --write to persist changes.");
  }

  if (refreshFailures.length > 0) {
    console.error("\n=== REFRESH FAILURES ===");
    for (const failure of refreshFailures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      "One or more providers could not be refreshed; their bundled data is stale. " +
        "Successful providers were still written.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
