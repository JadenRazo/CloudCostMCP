import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { mapStorageType } from "../mapping/storage-mapper.js";
import { logger } from "../logger.js";

// Default size assumption for object storage buckets that have no explicit
// size annotation in the Terraform configuration.
const DEFAULT_OBJECT_STORAGE_GB = 100;

// Well-known Terraform resource types that represent block storage volumes.
const BLOCK_STORAGE_RESOURCE_TYPES = new Set([
  "aws_ebs_volume",
  "azurerm_managed_disk",
  "google_compute_disk",
]);

// Provider-specific fallback storage types to use when the mapped type cannot
// be priced (e.g. object storage class names that don't exist in EBS tables).
// For AWS, gp3 is the general-purpose type with a reliable fallback price.
const BLOCK_STORAGE_FALLBACK: Record<string, string> = {
  aws: "gp3",
  azure: "Premium_LRS",
  gcp: "pd-ssd",
};

/**
 * Determines whether a parsed resource represents block storage (e.g. EBS,
 * Managed Disk, Persistent Disk) vs object storage (S3, Blob Storage, GCS).
 */
function isBlockStorage(resource: ParsedResource): boolean {
  return BLOCK_STORAGE_RESOURCE_TYPES.has(resource.type);
}

/**
 * Calculates the monthly storage cost for block or object storage resources.
 *
 * Block storage:  storage_size_gb * price_per_gb_month
 * Object storage: size is taken from attributes if present, otherwise the
 *                 DEFAULT_OBJECT_STORAGE_GB assumption is used and noted.
 */
export async function calculateStorageCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const block = isBlockStorage(resource);

  // Resolve storage type from attributes.
  const sourceStorageType =
    (resource.attributes.storage_type as string | undefined) ??
    (resource.attributes.type as string | undefined) ??
    (resource.attributes.storage_class as string | undefined) ??
    (block ? "gp3" : "STANDARD");

  const mappedStorageType =
    mapStorageType(sourceStorageType, resource.provider, targetProvider) ?? sourceStorageType;

  // Resolve size.
  let sizeGb =
    (resource.attributes.storage_size_gb as number | undefined) ??
    (resource.attributes.disk_size_gb as number | undefined) ??
    (resource.attributes.size as number | undefined);

  if (!sizeGb || sizeGb <= 0) {
    if (block) {
      // Block volumes with no explicit size default to 8 GB (provider minimum).
      sizeGb = 8;
      notes.push("No storage size specified; defaulting to 8 GB for block volume");
    } else {
      sizeGb = DEFAULT_OBJECT_STORAGE_GB;
      notes.push(
        `No storage size specified; assuming ${DEFAULT_OBJECT_STORAGE_GB} GB for object storage cost estimate`,
      );
    }
  }

  // Fetch price. For object storage, provider pricing APIs may not recognise
  // storage-class names (e.g. "STANDARD", "Hot") as valid EBS/disk types.
  // Fall back to a provider-appropriate block storage type so the estimate
  // always produces a non-zero result for the caller.
  let resolvedStorageType = mappedStorageType;
  let storagePrice = await pricingEngine
    .getProvider(targetProvider)
    .getStoragePrice(resolvedStorageType, targetRegion, sizeGb);

  if (!storagePrice && !block) {
    // Object storage class could not be priced directly; use the provider's
    // general-purpose block storage fallback rate as a proxy.
    const fallbackType = BLOCK_STORAGE_FALLBACK[targetProvider];
    if (fallbackType) {
      storagePrice = await pricingEngine
        .getProvider(targetProvider)
        .getStoragePrice(fallbackType, targetRegion, sizeGb);
      if (storagePrice) {
        resolvedStorageType = fallbackType;
        notes.push(
          `Object storage class "${mappedStorageType}" not directly priced; using ${fallbackType} rate as an approximation`,
        );
      }
    }
  }

  let totalMonthly = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (storagePrice) {
    const rawSource = storagePrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      pricingSource = "bundled";
    } else if (rawSource === "fallback") {
      pricingSource = "fallback";
      notes.push(
        `Pricing for ${resolvedStorageType} uses bundled fallback data (live API unavailable)`,
      );
    } else {
      pricingSource = "live";
    }

    totalMonthly = storagePrice.price_per_unit * sizeGb;
    breakdown.push({
      description: `${block ? "Block" : "Object"} storage ${resolvedStorageType} (${sizeGb} GB)`,
      unit: "GB-Mo",
      quantity: sizeGb,
      unit_price: storagePrice.price_per_unit,
      monthly_cost: totalMonthly,
    });
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
    logger.debug("calculateStorageCost: no price", {
      mappedStorageType,
      targetRegion,
    });
  }

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: storagePrice ? "high" : "low",
    notes,
    pricing_source: pricingSource,
  };
}
