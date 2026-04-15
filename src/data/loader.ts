import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ResourceEquivalent,
  RegionMapping,
  StorageMapping,
  InstanceSpec,
} from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the project root by walking up from the current file until we find
// package.json. This works both during development (src/data/loader.ts) and
// after bundling (dist/chunk-*.js) regardless of directory depth.
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    try {
      readFileSync(join(dir, "package.json"), "utf-8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return startDir; // filesystem root, give up
      dir = parent;
    }
  }
}

const DATA_DIR = join(findProjectRoot(__dirname), "data");

// ---------------------------------------------------------------------------
// Internal types for structured JSON shapes that don't directly map to
// exported domain types (e.g. nested maps or objects with mixed fields).
// ---------------------------------------------------------------------------

export interface InstanceMapData {
  aws_to_azure: Record<string, string>;
  aws_to_gcp: Record<string, string>;
  azure_to_aws: Record<string, string>;
  azure_to_gcp: Record<string, string>;
  gcp_to_aws: Record<string, string>;
  gcp_to_azure: Record<string, string>;
}

export interface StorageMapData {
  block_storage: StorageMapping[];
  object_storage: Array<{
    category: string;
    aws: string;
    azure: string;
    gcp: string;
  }>;
}

export interface GcpSqlRegionPricing {
  [tier: string]: number; // tier keys like "db-custom-1-3840", plus "storage_per_gb" and "ha_multiplier"
}

export interface GcpStorageRegionPricing {
  STANDARD: number;
  NEARLINE: number;
  COLDLINE: number;
  ARCHIVE: number;
}

export interface GcpDiskRegionPricing {
  "pd-standard": number;
  "pd-ssd": number;
  "pd-balanced": number;
}

export interface RegionPriceMultipliers {
  aws: Record<string, number>;
  azure: Record<string, number>;
  gcp: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Generic file loader – reads and parses a JSON file relative to DATA_DIR.
// Throws with the file path in the message if anything goes wrong so callers
// always know which file caused a problem.
// ---------------------------------------------------------------------------

function loadJsonFile<T>(relativePath: string): T {
  const fullPath = join(DATA_DIR, relativePath);
  try {
    return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
  } catch (err) {
    throw new Error(
      `Failed to load data file "${fullPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lazy-loaded module-level singletons. Each is initialised exactly once on
// first access and then cached for the lifetime of the process.
// ---------------------------------------------------------------------------

let _resourceEquivalents: ResourceEquivalent[] | null = null;
let _instanceMap: InstanceMapData | null = null;
let _regionMappings: RegionMapping[] | null = null;
let _storageMap: StorageMapData | null = null;
let _awsInstances: InstanceSpec[] | null = null;
let _azureVmSizes: InstanceSpec[] | null = null;
let _gcpMachineTypes: InstanceSpec[] | null = null;
let _gcpComputePricing: Record<string, Record<string, number>> | null = null;
let _gcpSqlPricing: Record<string, GcpSqlRegionPricing> | null = null;
let _gcpStoragePricing: Record<string, GcpStorageRegionPricing> | null = null;
let _gcpDiskPricing: Record<string, GcpDiskRegionPricing> | null = null;
let _regionPriceMultipliers: RegionPriceMultipliers | null = null;

// ---------------------------------------------------------------------------
// Public accessor functions
// ---------------------------------------------------------------------------

/**
 * Returns all cross-provider resource equivalents (e.g. aws_instance <-> azurerm_linux_virtual_machine).
 */
export function getResourceEquivalents(): ResourceEquivalent[] {
  if (_resourceEquivalents === null) {
    _resourceEquivalents = loadJsonFile<ResourceEquivalent[]>("resource-equivalents.json");
  }
  return _resourceEquivalents;
}

/**
 * Returns the pre-computed bidirectional instance type mapping table
 * covering all six provider-pair directions.
 */
export function getInstanceMap(): InstanceMapData {
  if (_instanceMap === null) {
    _instanceMap = loadJsonFile<InstanceMapData>("instance-map.json");
  }
  return _instanceMap;
}

/**
 * Returns the list of geographically equivalent regions across AWS, Azure, and GCP.
 */
export function getRegionMappings(): RegionMapping[] {
  if (_regionMappings === null) {
    _regionMappings = loadJsonFile<RegionMapping[]>("region-mappings.json");
  }
  return _regionMappings;
}

/**
 * Returns the storage tier mapping data covering both block and object storage
 * across all three providers.
 */
export function getStorageMap(): StorageMapData {
  if (_storageMap === null) {
    _storageMap = loadJsonFile<StorageMapData>("storage-map.json");
  }
  return _storageMap;
}

/**
 * Returns the catalogue of AWS EC2 and RDS instance specifications.
 */
export function getAwsInstances(): InstanceSpec[] {
  if (_awsInstances === null) {
    _awsInstances = loadJsonFile<InstanceSpec[]>("instance-types/aws-instances.json");
  }
  return _awsInstances;
}

/**
 * Returns the catalogue of Azure VM size specifications.
 */
export function getAzureVmSizes(): InstanceSpec[] {
  if (_azureVmSizes === null) {
    _azureVmSizes = loadJsonFile<InstanceSpec[]>("instance-types/azure-vm-sizes.json");
  }
  return _azureVmSizes;
}

/**
 * Returns the catalogue of GCP Compute Engine and Cloud SQL machine type specifications.
 */
export function getGcpMachineTypes(): InstanceSpec[] {
  if (_gcpMachineTypes === null) {
    _gcpMachineTypes = loadJsonFile<InstanceSpec[]>("instance-types/gcp-machine-types.json");
  }
  return _gcpMachineTypes;
}

/**
 * Returns bundled GCP Compute Engine on-demand hourly pricing keyed by
 * region then machine type.
 */
export function getGcpComputePricing(): Record<string, Record<string, number>> {
  if (_gcpComputePricing === null) {
    _gcpComputePricing = loadJsonFile<Record<string, Record<string, number>>>(
      "gcp-pricing/compute-engine.json",
    );
  }
  return _gcpComputePricing;
}

/**
 * Returns bundled GCP Cloud SQL hourly pricing keyed by region.
 * Each region entry maps tier names (and the special keys "storage_per_gb"
 * and "ha_multiplier") to numeric values.
 */
export function getGcpSqlPricing(): Record<string, GcpSqlRegionPricing> {
  if (_gcpSqlPricing === null) {
    _gcpSqlPricing = loadJsonFile<Record<string, GcpSqlRegionPricing>>(
      "gcp-pricing/cloud-sql.json",
    );
  }
  return _gcpSqlPricing;
}

/**
 * Returns bundled GCP Cloud Storage per-GB/month pricing keyed by region
 * then storage class (STANDARD, NEARLINE, COLDLINE, ARCHIVE).
 */
export function getGcpStoragePricing(): Record<string, GcpStorageRegionPricing> {
  if (_gcpStoragePricing === null) {
    _gcpStoragePricing = loadJsonFile<Record<string, GcpStorageRegionPricing>>(
      "gcp-pricing/cloud-storage.json",
    );
  }
  return _gcpStoragePricing;
}

/**
 * Returns bundled GCP Persistent Disk per-GB/month pricing keyed by region
 * then disk type (pd-standard, pd-ssd, pd-balanced).
 */
export function getGcpDiskPricing(): Record<string, GcpDiskRegionPricing> {
  if (_gcpDiskPricing === null) {
    _gcpDiskPricing = loadJsonFile<Record<string, GcpDiskRegionPricing>>(
      "gcp-pricing/persistent-disk.json",
    );
  }
  return _gcpDiskPricing;
}

/**
 * Returns the per-region price multipliers relative to the baseline US region
 * for each cloud provider. These are used to adjust fallback (hardcoded)
 * pricing when live API calls are unavailable, so non-US regions produce
 * more accurate estimates rather than defaulting to us-east-1/us-central1 rates.
 */
export function getRegionPriceMultipliers(): RegionPriceMultipliers {
  if (_regionPriceMultipliers === null) {
    _regionPriceMultipliers = loadJsonFile<RegionPriceMultipliers>("region-price-multipliers.json");
  }
  return _regionPriceMultipliers;
}

// ---------------------------------------------------------------------------
// Provider fallback metadata — written by scripts/refresh-pricing.ts.
// Surfaces the freshness of bundled fallback tables to downstream callers.
// Returns null for any provider whose metadata file is missing (e.g. before
// the first refresh run for that provider).
// ---------------------------------------------------------------------------

export interface FallbackMetadata {
  last_updated: string;
  source?: string;
  sku_count?: number;
  refresh_script_version?: string;
  currency?: string;
  notes?: string;
}

const _fallbackMeta: Record<string, FallbackMetadata | null> = {};

export function getFallbackMetadata(provider: "aws" | "azure" | "gcp"): FallbackMetadata | null {
  if (_fallbackMeta[provider] !== undefined) return _fallbackMeta[provider];
  const relPath = `${provider}-pricing/metadata.json`;
  try {
    _fallbackMeta[provider] = loadJsonFile<FallbackMetadata>(relPath);
  } catch {
    _fallbackMeta[provider] = null;
  }
  return _fallbackMeta[provider];
}

// ---------------------------------------------------------------------------
// Cache reset – only useful in tests that need a clean slate between runs.
// Not exported to consumers; imported via the test helper path if needed.
// ---------------------------------------------------------------------------

/** @internal */
export function _resetLoaderCache(): void {
  _resourceEquivalents = null;
  _instanceMap = null;
  _regionMappings = null;
  _storageMap = null;
  _awsInstances = null;
  _azureVmSizes = null;
  _gcpMachineTypes = null;
  _gcpComputePricing = null;
  _gcpSqlPricing = null;
  _gcpStoragePricing = null;
  _gcpDiskPricing = null;
  _regionPriceMultipliers = null;
}
