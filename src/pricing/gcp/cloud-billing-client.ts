import type { NormalizedPrice } from "../../types/pricing.js";
import type { PricingCache } from "../cache.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// GCP Cloud Billing Catalog API
// Public endpoint, no authentication required for public SKU listings.
// ---------------------------------------------------------------------------

const BILLING_API_BASE = "https://cloudbilling.googleapis.com/v1/services";

// Known public service IDs from the GCP Cloud Billing Catalog
const SERVICE_IDS = {
  COMPUTE: "6F81-5844-456A",
  CLOUD_SQL: "9662-B51E-5089",
  CLOUD_STORAGE: "95FF-2EF5-5EA1",
} as const;

// 24-hour TTL — live pricing changes infrequently
const CACHE_TTL = 86400;

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface TieredRate {
  startUsageAmount: number;
  unitPrice: {
    currencyCode: string;
    units?: string;
    nanos?: number;
  };
}

interface PricingExpression {
  usageUnit: string;
  displayQuantity?: number;
  tieredRates: TieredRate[];
}

interface PricingInfo {
  effectiveTime?: string;
  pricingExpression: PricingExpression;
}

interface GcpSku {
  name: string;
  skuId: string;
  description: string;
  category: {
    serviceDisplayName: string;
    resourceFamily: string;
    resourceGroup: string;
    usageType: string;
  };
  serviceRegions: string[];
  pricingInfo: PricingInfo[];
}

interface SkuListResponse {
  skus: GcpSku[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Helper — convert GCP money proto (units + nanos) to a plain float
// ---------------------------------------------------------------------------

function protoToFloat(units?: string, nanos?: number): number {
  const u = parseInt(units ?? "0", 10) || 0;
  const n = nanos ?? 0;
  return u + n / 1_000_000_000;
}

/**
 * Extract the lowest-tier unit price from a SKU's pricing info.
 * The Cloud Billing API expresses prices as tiered rates; for on-demand
 * pricing the first tier (startUsageAmount === 0) is the standard rate.
 */
function extractUnitPrice(sku: GcpSku): number | null {
  const pricing = sku.pricingInfo?.[0];
  if (!pricing) return null;

  const rates = pricing.pricingExpression?.tieredRates ?? [];
  // Prefer the rate whose start amount is 0 (first/base tier)
  const baseTier = rates.find((r) => r.startUsageAmount === 0) ?? rates[0];
  if (!baseTier) return null;

  const price = protoToFloat(baseTier.unitPrice?.units, baseTier.unitPrice?.nanos);
  return price > 0 ? price : null;
}

// ---------------------------------------------------------------------------
// GCP region normalisation
// The API uses full region strings like "us-central1". We accept them as-is
// but need to match SKU serviceRegions which may use "us-central1" or a
// broader key like "us". We check both exact and prefix matches.
// ---------------------------------------------------------------------------

function skuCoversRegion(sku: GcpSku, region: string): boolean {
  const regions = sku.serviceRegions ?? [];
  const lower = region.toLowerCase();

  // "global" SKUs cover all regions
  if (regions.includes("global")) return true;

  // Exact match
  if (regions.some((r) => r.toLowerCase() === lower)) return true;

  // Prefix match: "us-central1" is covered by "us" parent
  const prefix = lower.split("-")[0];
  if (prefix && regions.some((r) => r.toLowerCase() === prefix)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// CloudBillingClient
// ---------------------------------------------------------------------------

export class CloudBillingClient {
  private cache: PricingCache;

  constructor(cache: PricingCache) {
    this.cache = cache;
  }

  // -------------------------------------------------------------------------
  // Public fetch methods
  // -------------------------------------------------------------------------

  /**
   * Fetch Compute Engine SKUs for a region and return the hourly instance
   * price for the given machine type, or null if not found.
   */
  async fetchComputeSkus(machineType: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = `gcp/compute/${region}/${machineType.toLowerCase()}`;
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.COMPUTE, region);

      // Machine type SKUs have descriptions like:
      // "N2 Instance Core running in Americas" / "E2 Instance Core running in Americas"
      // We match by looking for the machine family prefix in the description.
      const family = this.machineFamily(machineType);
      const result = this.extractComputePrice(skus, machineType, family, region);

      if (result) {
        this.cache.set(cacheKey, result, "gcp", "compute", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("GCP Cloud Billing compute fetch failed", {
        machineType,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  /**
   * Fetch Cloud SQL SKUs and return the hourly price for the given tier.
   */
  async fetchDatabaseSkus(tier: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = `gcp/sql/${region}/${tier.toLowerCase()}`;
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.CLOUD_SQL, region);
      const result = this.extractDatabasePrice(skus, tier, region);

      if (result) {
        this.cache.set(cacheKey, result, "gcp", "cloud-sql", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("GCP Cloud Billing SQL fetch failed", {
        tier,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  /**
   * Fetch Cloud Storage SKUs and return the monthly per-GB price for the
   * given storage class.
   */
  async fetchStorageSkus(storageClass: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = `gcp/storage/${region}/${storageClass.toLowerCase()}`;
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.CLOUD_STORAGE, region);
      const result = this.extractStoragePrice(skus, storageClass, region);

      if (result) {
        this.cache.set(cacheKey, result, "gcp", "cloud-storage", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("GCP Cloud Billing storage fetch failed", {
        storageClass,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Internal – API fetch
  // -------------------------------------------------------------------------

  /**
   * Page through all SKUs for a GCP billing service, filtering to those that
   * cover the requested region. Returns the filtered SKU array.
   *
   * The public endpoint supports no authentication for read-only SKU listing.
   * Pagination is handled via nextPageToken.
   */
  private async fetchSkus(serviceId: string, region: string): Promise<GcpSku[]> {
    const url = `${BILLING_API_BASE}/${serviceId}/skus`;
    const collected: GcpSku[] = [];
    let pageToken: string | undefined;

    do {
      const pageUrl = pageToken ? `${url}?pageToken=${pageToken}` : url;

      logger.debug("GCP Cloud Billing API request", { url: pageUrl, serviceId, region });

      const res = await fetch(pageUrl, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        throw new Error(`GCP Billing API HTTP ${res.status} for service ${serviceId}`);
      }

      const body: SkuListResponse = await res.json();
      const skus: GcpSku[] = body.skus ?? [];

      // Only keep SKUs that cover the target region
      for (const sku of skus) {
        if (skuCoversRegion(sku, region)) {
          collected.push(sku);
        }
      }

      pageToken = body.nextPageToken;
    } while (pageToken);

    logger.debug("GCP Cloud Billing SKUs fetched", {
      serviceId,
      region,
      count: collected.length,
    });

    return collected;
  }

  // -------------------------------------------------------------------------
  // Internal – SKU matching helpers
  // -------------------------------------------------------------------------

  /**
   * Extract the machine family prefix from a machine type string.
   * "n2-standard-4" → "n2"
   * "e2-micro"      → "e2"
   * "c2-standard-8" → "c2"
   */
  private machineFamily(machineType: string): string {
    return machineType.split("-")[0]?.toLowerCase() ?? machineType.toLowerCase();
  }

  /**
   * From a list of Compute Engine SKUs, find the best price for the given
   * machine type. The API does not have per-instance-type SKUs; instead it
   * has per-resource (vCPU, RAM) SKUs per machine family. This method finds
   * the core/vCPU hourly SKU for the family and returns it as a proxy for the
   * full instance price (the bundled loader provides the assembled price).
   *
   * We return the first matching SKU's unit price tagged with `pricing_source:
   * "live"` so callers can distinguish from bundled data.
   */
  private extractComputePrice(
    skus: GcpSku[],
    machineType: string,
    family: string,
    region: string,
  ): NormalizedPrice | null {
    const familyUpper = family.toUpperCase();

    // Look for a predefined instance-hour SKU whose description contains
    // the family prefix (e.g. "E2 Instance Core", "N2 Instance Core").
    // Prefer SKUs labelled "Core" or "Ram" for the matching family.
    const candidates = skus.filter((s) => {
      const desc = s.description.toUpperCase();
      return (
        desc.includes(familyUpper) &&
        s.category.resourceFamily === "Compute" &&
        s.category.usageType === "OnDemand" &&
        // We want vCPU-hour SKUs as the representative price signal
        (desc.includes("CORE") || desc.includes("VCPU") || desc.includes("INSTANCE CORE"))
      );
    });

    if (candidates.length === 0) return null;

    // Sort by SKU ID for determinism, pick the first
    candidates.sort((a, b) => a.skuId.localeCompare(b.skuId));
    const sku = candidates[0]!;

    const price = extractUnitPrice(sku);
    if (price === null) return null;

    return {
      provider: "gcp",
      service: "compute-engine",
      resource_type: machineType,
      region,
      unit: "h",
      price_per_unit: price,
      currency: "USD",
      description: `GCP Compute Engine ${machineType} (live: ${sku.description})`,
      attributes: {
        machine_type: machineType,
        machine_family: family,
        sku_id: sku.skuId,
        pricing_source: "live",
      },
      effective_date: sku.pricingInfo?.[0]?.effectiveTime ?? new Date().toISOString(),
    };
  }

  /**
   * Extract a Cloud SQL hourly price for the given tier.
   * Cloud SQL SKU descriptions contain the tier class information:
   * e.g. "DB custom CORE running in Americas"
   */
  private extractDatabasePrice(
    skus: GcpSku[],
    tier: string,
    region: string,
  ): NormalizedPrice | null {
    const tierLower = tier.toLowerCase();

    // Cloud SQL tiers follow the pattern: db-custom-{vCPUs}-{memory}
    // SKUs are per-core/per-GB-RAM. We look for a Cloud SQL core running SKU.
    const candidates = skus.filter((s) => {
      const desc = s.description.toLowerCase();
      return (
        s.category.resourceFamily === "ApplicationServices" &&
        s.category.usageType === "OnDemand" &&
        (desc.includes("core") || desc.includes("vcpu")) &&
        // Exclude storage SKUs
        !desc.includes("storage") &&
        !desc.includes("io") &&
        !desc.includes("network")
      );
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.skuId.localeCompare(b.skuId));
    const sku = candidates[0]!;

    const price = extractUnitPrice(sku);
    if (price === null) return null;

    return {
      provider: "gcp",
      service: "cloud-sql",
      resource_type: tier,
      region,
      unit: "h",
      price_per_unit: price,
      currency: "USD",
      description: `GCP Cloud SQL ${tier} (live: ${sku.description})`,
      attributes: {
        tier: tierLower,
        sku_id: sku.skuId,
        pricing_source: "live",
      },
      effective_date: sku.pricingInfo?.[0]?.effectiveTime ?? new Date().toISOString(),
    };
  }

  /**
   * Extract a Cloud Storage per-GB monthly price for the given storage class.
   */
  private extractStoragePrice(
    skus: GcpSku[],
    storageClass: string,
    region: string,
  ): NormalizedPrice | null {
    const classUpper = storageClass.toUpperCase();

    // Storage class → keyword mapping for SKU description matching
    const classKeywords: Record<string, string[]> = {
      STANDARD: ["standard storage"],
      NEARLINE: ["nearline storage"],
      COLDLINE: ["coldline storage"],
      ARCHIVE: ["archive storage"],
    };

    const keywords = classKeywords[classUpper] ?? [classUpper.toLowerCase() + " storage"];

    const candidates = skus.filter((s) => {
      const desc = s.description.toLowerCase();
      return (
        s.category.resourceFamily === "Storage" &&
        s.category.usageType === "OnDemand" &&
        keywords.some((kw) => desc.includes(kw)) &&
        !desc.includes("retrieval") &&
        !desc.includes("operation") &&
        !desc.includes("network")
      );
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.skuId.localeCompare(b.skuId));
    const sku = candidates[0]!;

    const price = extractUnitPrice(sku);
    if (price === null) return null;

    return {
      provider: "gcp",
      service: "cloud-storage",
      resource_type: classUpper,
      region,
      unit: "GiBy.mo",
      price_per_unit: price,
      currency: "USD",
      description: `GCP Cloud Storage ${classUpper} (live: ${sku.description})`,
      attributes: {
        storage_class: classUpper,
        sku_id: sku.skuId,
        pricing_source: "live",
      },
      effective_date: sku.pricingInfo?.[0]?.effectiveTime ?? new Date().toISOString(),
    };
  }
}
