import type { NormalizedPrice } from "../../types/pricing.js";
import { resolveEffectiveDate } from "../effective-date.js";

/**
 * Convert GCP pricing data into the canonical NormalizedPrice shape.
 *
 * The `normalizeGcp*` functions handle bundled (JSON file) data.
 * The `normalizeGcpLive*` functions handle data from the Cloud Billing API.
 */

interface GcpNormalizeSpec {
  service: string;
  unit: string;
  /** Human-readable prefix, e.g. "GCP Compute Engine". */
  descriptionPrefix: string;
  /** Attribute key the resource type is stored under (machine_type, tier, ...). */
  attrKey: string;
}

interface GcpNormalizeOptions {
  source: "bundled" | "live";
  skuId?: string;
  effectiveDate?: string;
}

/**
 * Shared body of the GCP normalizers: assembles the canonical NormalizedPrice
 * literal for both bundled and live (Cloud Billing API) data.
 */
function normalize(
  resourceType: string,
  pricePerUnit: number,
  region: string,
  spec: GcpNormalizeSpec,
  opts: GcpNormalizeOptions,
): NormalizedPrice {
  return {
    provider: "gcp",
    service: spec.service,
    resource_type: resourceType,
    region,
    unit: spec.unit,
    price_per_unit: pricePerUnit,
    currency: "USD",
    description: `${spec.descriptionPrefix} ${resourceType}`,
    attributes: {
      [spec.attrKey]: resourceType,
      ...(opts.skuId !== undefined ? { sku_id: opts.skuId } : {}),
      pricing_source: opts.source,
    },
    effective_date: resolveEffectiveDate(opts.effectiveDate),
  };
}

const COMPUTE_SPEC: GcpNormalizeSpec = {
  service: "compute-engine",
  unit: "h",
  descriptionPrefix: "GCP Compute Engine",
  attrKey: "machine_type",
};

const DATABASE_SPEC: GcpNormalizeSpec = {
  service: "cloud-sql",
  unit: "h",
  descriptionPrefix: "GCP Cloud SQL",
  attrKey: "tier",
};

const STORAGE_SPEC: GcpNormalizeSpec = {
  service: "cloud-storage",
  unit: "GiBy.mo",
  descriptionPrefix: "GCP Cloud Storage",
  attrKey: "storage_class",
};

const DISK_SPEC: GcpNormalizeSpec = {
  service: "persistent-disk",
  unit: "GiBy.mo",
  descriptionPrefix: "GCP Persistent Disk",
  attrKey: "disk_type",
};

// ---------------------------------------------------------------------------
// Bundled (JSON file) normalizers
// ---------------------------------------------------------------------------

export function normalizeGcpCompute(
  machineType: string,
  hourlyPrice: number,
  region: string,
): NormalizedPrice {
  return normalize(machineType, hourlyPrice, region, COMPUTE_SPEC, { source: "bundled" });
}

export function normalizeGcpDatabase(
  tier: string,
  hourlyPrice: number,
  region: string,
): NormalizedPrice {
  return normalize(tier, hourlyPrice, region, DATABASE_SPEC, { source: "bundled" });
}

export function normalizeGcpStorage(
  storageClass: string,
  pricePerGb: number,
  region: string,
): NormalizedPrice {
  return normalize(storageClass, pricePerGb, region, STORAGE_SPEC, { source: "bundled" });
}

export function normalizeGcpDisk(
  diskType: string,
  pricePerGb: number,
  region: string,
): NormalizedPrice {
  return normalize(diskType, pricePerGb, region, DISK_SPEC, { source: "bundled" });
}

// ---------------------------------------------------------------------------
// Live (Cloud Billing API) normalizers
// These accept the raw unit price from the API and produce the same
// NormalizedPrice shape but with pricing_source: "live".
// ---------------------------------------------------------------------------

export function normalizeGcpLiveCompute(
  machineType: string,
  pricePerHour: number,
  region: string,
  skuId: string,
  effectiveDate?: string,
): NormalizedPrice {
  return normalize(machineType, pricePerHour, region, COMPUTE_SPEC, {
    source: "live",
    skuId,
    effectiveDate,
  });
}

export function normalizeGcpLiveDatabase(
  tier: string,
  pricePerHour: number,
  region: string,
  skuId: string,
  effectiveDate?: string,
): NormalizedPrice {
  return normalize(tier, pricePerHour, region, DATABASE_SPEC, {
    source: "live",
    skuId,
    effectiveDate,
  });
}

export function normalizeGcpLiveStorage(
  storageClass: string,
  pricePerGbMonth: number,
  region: string,
  skuId: string,
  effectiveDate?: string,
): NormalizedPrice {
  return normalize(storageClass.toUpperCase(), pricePerGbMonth, region, STORAGE_SPEC, {
    source: "live",
    skuId,
    effectiveDate,
  });
}
