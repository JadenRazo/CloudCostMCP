import type { NormalizedPrice } from "../../types/pricing.js";

/**
 * Convert GCP pricing data into the canonical NormalizedPrice shape.
 *
 * The `normalizeGcp*` functions handle bundled (JSON file) data.
 * The `normalizeGcpLive*` functions handle data from the Cloud Billing API.
 */

export function normalizeGcpCompute(
  machineType: string,
  hourlyPrice: number,
  region: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "compute-engine",
    resource_type: machineType,
    region,
    unit: "h",
    price_per_unit: hourlyPrice,
    currency: "USD",
    description: `GCP Compute Engine ${machineType}`,
    attributes: {
      machine_type: machineType,
      pricing_source: "bundled",
    },
    effective_date: new Date().toISOString(),
  };
}

export function normalizeGcpDatabase(
  tier: string,
  hourlyPrice: number,
  region: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "cloud-sql",
    resource_type: tier,
    region,
    unit: "h",
    price_per_unit: hourlyPrice,
    currency: "USD",
    description: `GCP Cloud SQL ${tier}`,
    attributes: {
      tier,
      pricing_source: "bundled",
    },
    effective_date: new Date().toISOString(),
  };
}

export function normalizeGcpStorage(
  storageClass: string,
  pricePerGb: number,
  region: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "cloud-storage",
    resource_type: storageClass,
    region,
    unit: "GiBy.mo",
    price_per_unit: pricePerGb,
    currency: "USD",
    description: `GCP Cloud Storage ${storageClass}`,
    attributes: {
      storage_class: storageClass,
      pricing_source: "bundled",
    },
    effective_date: new Date().toISOString(),
  };
}

export function normalizeGcpDisk(
  diskType: string,
  pricePerGb: number,
  region: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "persistent-disk",
    resource_type: diskType,
    region,
    unit: "GiBy.mo",
    price_per_unit: pricePerGb,
    currency: "USD",
    description: `GCP Persistent Disk ${diskType}`,
    attributes: {
      disk_type: diskType,
      pricing_source: "bundled",
    },
    effective_date: new Date().toISOString(),
  };
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
  effectiveDate?: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "compute-engine",
    resource_type: machineType,
    region,
    unit: "h",
    price_per_unit: pricePerHour,
    currency: "USD",
    description: `GCP Compute Engine ${machineType}`,
    attributes: {
      machine_type: machineType,
      sku_id: skuId,
      pricing_source: "live",
    },
    effective_date: effectiveDate ?? new Date().toISOString(),
  };
}

export function normalizeGcpLiveDatabase(
  tier: string,
  pricePerHour: number,
  region: string,
  skuId: string,
  effectiveDate?: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "cloud-sql",
    resource_type: tier,
    region,
    unit: "h",
    price_per_unit: pricePerHour,
    currency: "USD",
    description: `GCP Cloud SQL ${tier}`,
    attributes: {
      tier,
      sku_id: skuId,
      pricing_source: "live",
    },
    effective_date: effectiveDate ?? new Date().toISOString(),
  };
}

export function normalizeGcpLiveStorage(
  storageClass: string,
  pricePerGbMonth: number,
  region: string,
  skuId: string,
  effectiveDate?: string
): NormalizedPrice {
  return {
    provider: "gcp",
    service: "cloud-storage",
    resource_type: storageClass.toUpperCase(),
    region,
    unit: "GiBy.mo",
    price_per_unit: pricePerGbMonth,
    currency: "USD",
    description: `GCP Cloud Storage ${storageClass.toUpperCase()}`,
    attributes: {
      storage_class: storageClass.toUpperCase(),
      sku_id: skuId,
      pricing_source: "live",
    },
    effective_date: effectiveDate ?? new Date().toISOString(),
  };
}
