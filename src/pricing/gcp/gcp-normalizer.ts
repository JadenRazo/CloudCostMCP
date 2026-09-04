import type { NormalizedPrice } from "../../types/pricing.js";
import { resolveEffectiveDate } from "../effective-date.js";

/**
 * Convert bundled GCP pricing data into the canonical NormalizedPrice shape.
 *
 * CloudCost has no credential-free live GCP pricing path. All GCP pricing
 * normalized here comes from bundled data and is explicitly tagged as such.
 */

interface GcpNormalizeSpec {
  service: string;
  unit: string;
  /** Human-readable prefix, e.g. "GCP Compute Engine". */
  descriptionPrefix: string;
  /** Attribute key the resource type is stored under (machine_type, tier, ...). */
  attrKey: string;
}

/** Shared body for bundled GCP normalizers. */
function normalize(
  resourceType: string,
  pricePerUnit: number,
  region: string,
  spec: GcpNormalizeSpec,
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
      pricing_source: "bundled",
    },
    effective_date: resolveEffectiveDate(undefined),
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

export function normalizeGcpCompute(
  machineType: string,
  hourlyPrice: number,
  region: string,
): NormalizedPrice {
  return normalize(machineType, hourlyPrice, region, COMPUTE_SPEC);
}

export function normalizeGcpDatabase(
  tier: string,
  hourlyPrice: number,
  region: string,
): NormalizedPrice {
  return normalize(tier, hourlyPrice, region, DATABASE_SPEC);
}

export function normalizeGcpStorage(
  storageClass: string,
  pricePerGb: number,
  region: string,
): NormalizedPrice {
  return normalize(storageClass, pricePerGb, region, STORAGE_SPEC);
}

export function normalizeGcpDisk(
  diskType: string,
  pricePerGb: number,
  region: string,
): NormalizedPrice {
  return normalize(diskType, pricePerGb, region, DISK_SPEC);
}
