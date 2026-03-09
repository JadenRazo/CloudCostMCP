import type { NormalizedPrice } from "../../types/pricing.js";

/**
 * Convert bundled GCP pricing data (plain numbers from JSON files) into the
 * canonical NormalizedPrice shape.
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
