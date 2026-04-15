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
  // GKE (Kubernetes Engine) service — used to locate Autopilot pod SKUs.
  GKE: "CCD8-9BF1-090E",
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

  /**
   * Fetch Compute Engine GPU (accelerator) SKUs and return the hourly price
   * for the given accelerator type (e.g. "nvidia-tesla-t4", "nvidia-a100").
   *
   * GPUs live under the Compute service (6F81-5844-456A) with
   * `category.resourceFamily == "Compute"` and
   * `category.resourceGroup == "GPU"`. Descriptions follow the pattern
   * "Nvidia Tesla T4 GPU running in Americas".
   */
  async fetchGpuSkus(accelerator: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = `gcp/gpu/${region}/${accelerator.toLowerCase()}`;
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.COMPUTE, region);
      const result = this.extractGpuPrice(skus, accelerator, region);

      if (result) {
        this.cache.set(cacheKey, result, "gcp", "compute-gpu", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("GCP Cloud Billing GPU fetch failed", {
        accelerator,
        region,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  /**
   * Fetch Committed Use Discount (CUD) rates for the Compute service in a
   * region. Returns discount fractions (0..1) against OnDemand base rates,
   * derived by comparing matching Commit1Yr / Commit3Yr SKUs to their
   * OnDemand counterparts for the same resource group (e.g. "N1Standard").
   *
   * If the API call fails or no matching SKUs are found, returns null and
   * callers should fall back to static rates.
   */
  async fetchCudRates(region: string): Promise<{
    term1yr: number | null;
    term3yr: number | null;
    sample_count: number;
  } | null> {
    const cacheKey = `gcp/cud/${region}`;
    const cached = this.cache.get<{
      term1yr: number | null;
      term3yr: number | null;
      sample_count: number;
    }>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.COMPUTE, region);

      // Build OnDemand baseline map keyed by resourceGroup + "core" flag.
      // We pair each Commit SKU with the OnDemand SKU that shares the same
      // resourceGroup and the same core/ram descriptor.
      type Key = string;
      const onDemand: Map<Key, number> = new Map();
      const commit1: Map<Key, number> = new Map();
      const commit3: Map<Key, number> = new Map();

      const keyOf = (sku: GcpSku): Key | null => {
        const group = sku.category.resourceGroup ?? "";
        if (!group) return null;
        const desc = sku.description.toLowerCase();
        // Only pair like with like: core vs ram.
        let flavour: string;
        if (desc.includes("core") || desc.includes("vcpu")) {
          flavour = "core";
        } else if (desc.includes("ram") || desc.includes("memory")) {
          flavour = "ram";
        } else {
          return null;
        }
        return `${group}|${flavour}`;
      };

      for (const sku of skus) {
        if (sku.category.resourceFamily !== "Compute") continue;
        const price = extractUnitPrice(sku);
        if (price === null) continue;
        const key = keyOf(sku);
        if (!key) continue;

        const usage = sku.category.usageType;
        if (usage === "OnDemand") {
          // Prefer the lowest OnDemand price per key (standard rate).
          const existing = onDemand.get(key);
          if (existing === undefined || price < existing) onDemand.set(key, price);
        } else if (usage === "Commit1Yr") {
          const existing = commit1.get(key);
          if (existing === undefined || price < existing) commit1.set(key, price);
        } else if (usage === "Commit3Yr") {
          const existing = commit3.get(key);
          if (existing === undefined || price < existing) commit3.set(key, price);
        }
      }

      // Compute average discount fraction across all keys that have both
      // an OnDemand SKU and a committed SKU.
      const averageDiscount = (commits: Map<Key, number>): number | null => {
        const ratios: number[] = [];
        for (const [key, commitPrice] of commits) {
          const base = onDemand.get(key);
          if (base === undefined || base <= 0) continue;
          // Commit SKUs are hourly-equivalent rates — discount = 1 - commit/base.
          const discount = 1 - commitPrice / base;
          if (discount > 0 && discount < 1) ratios.push(discount);
        }
        if (ratios.length === 0) return null;
        const sum = ratios.reduce((a, b) => a + b, 0);
        return sum / ratios.length;
      };

      const result = {
        term1yr: averageDiscount(commit1),
        term3yr: averageDiscount(commit3),
        sample_count: onDemand.size,
      };

      if (result.term1yr === null && result.term3yr === null) {
        return null;
      }

      this.cache.set(cacheKey, result, "gcp", "compute-cud", region, CACHE_TTL);
      return result;
    } catch (err) {
      logger.warn("GCP Cloud Billing CUD fetch failed", {
        region,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetch GKE Autopilot pod resource rates (per-vCPU-hour, per-GB-memory-hour,
   * per-GB-ephemeral-storage-hour) from the GKE service catalog. Returns a
   * NormalizedPrice whose `price_per_unit` is the vCPU rate and whose
   * `attributes` carry the memory/storage rates as strings — callers that
   * know a pod's resource request can compute an exact per-pod price.
   */
  async fetchAutopilotPodRates(region: string): Promise<NormalizedPrice | null> {
    const cacheKey = `gcp/gke-autopilot/${region}`;
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const skus = await this.fetchSkus(SERVICE_IDS.GKE, region);
      const result = this.extractAutopilotPodRates(skus, region);

      if (result) {
        this.cache.set(cacheKey, result, "gcp", "gke-autopilot", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("GCP Cloud Billing GKE Autopilot fetch failed", {
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

  /**
   * Extract a GPU hourly price for the requested accelerator type.
   * Matches SKUs with resourceGroup == "GPU" whose description contains the
   * human-readable model name (e.g. "Tesla T4", "A100 40GB").
   */
  private extractGpuPrice(
    skus: GcpSku[],
    accelerator: string,
    region: string,
  ): NormalizedPrice | null {
    // Normalise accelerator to a set of keywords we can match against the
    // SKU description. We drop the "nvidia-" prefix if present and split on
    // dashes so "nvidia-tesla-t4" → ["tesla", "t4"] and "nvidia-a100-80gb" →
    // ["a100", "80gb"].
    const lower = accelerator.toLowerCase();
    const stripped = lower.replace(/^nvidia-?/, "");
    const tokens = stripped.split(/[-\s]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;

    const candidates = skus.filter((s) => {
      if (s.category.resourceFamily !== "Compute") return false;
      if (s.category.resourceGroup !== "GPU") return false;
      if (s.category.usageType !== "OnDemand") return false;
      const desc = s.description.toLowerCase();
      // All tokens must appear in the description.
      return tokens.every((tok) => desc.includes(tok));
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.skuId.localeCompare(b.skuId));
    const sku = candidates[0]!;

    const price = extractUnitPrice(sku);
    if (price === null) return null;

    return {
      provider: "gcp",
      service: "compute-engine",
      resource_type: accelerator,
      region,
      unit: "h",
      price_per_unit: price,
      currency: "USD",
      description: `GCP GPU ${accelerator} (live: ${sku.description})`,
      attributes: {
        accelerator,
        sku_id: sku.skuId,
        pricing_source: "live",
      },
      effective_date: sku.pricingInfo?.[0]?.effectiveTime ?? new Date().toISOString(),
    };
  }

  /**
   * Extract GKE Autopilot pod resource rates. Autopilot exposes separate
   * SKUs per resource dimension (vCPU, memory, ephemeral storage) under the
   * GKE service. We look for SKUs whose description contains "Autopilot"
   * and the matching dimension keyword.
   */
  private extractAutopilotPodRates(skus: GcpSku[], region: string): NormalizedPrice | null {
    const autopilotSkus = skus.filter((s) => {
      const desc = s.description.toLowerCase();
      return (
        s.category.usageType === "OnDemand" &&
        desc.includes("autopilot") &&
        !desc.includes("spot") &&
        !desc.includes("preemptible")
      );
    });

    if (autopilotSkus.length === 0) return null;

    const find = (keywords: string[]): GcpSku | undefined => {
      const matches = autopilotSkus.filter((s) => {
        const desc = s.description.toLowerCase();
        return keywords.every((kw) => desc.includes(kw));
      });
      if (matches.length === 0) return undefined;
      matches.sort((a, b) => a.skuId.localeCompare(b.skuId));
      return matches[0];
    };

    const vcpuSku = find(["cpu"]) ?? find(["core"]) ?? find(["vcpu"]);
    const memorySku = find(["memory"]) ?? find(["ram"]);
    const storageSku = find(["ephemeral", "storage"]) ?? find(["storage"]);

    if (!vcpuSku) return null;

    const vcpuPrice = extractUnitPrice(vcpuSku);
    if (vcpuPrice === null) return null;

    const memoryPrice = memorySku ? extractUnitPrice(memorySku) : null;
    const storagePrice = storageSku ? extractUnitPrice(storageSku) : null;

    const attributes: Record<string, string> = {
      mode: "autopilot",
      pricing_model: "per_pod_resource",
      pricing_source: "live",
      vcpu_hourly: String(vcpuPrice),
      sku_id_vcpu: vcpuSku.skuId,
      pricing_note:
        "Autopilot charges per pod: vCPU, memory, and ephemeral storage are billed separately. price_per_unit reports the vCPU/hr rate; see attributes for memory/storage rates.",
    };
    if (memoryPrice !== null && memorySku) {
      attributes.memory_gb_hourly = String(memoryPrice);
      attributes.sku_id_memory = memorySku.skuId;
    }
    if (storagePrice !== null && storageSku) {
      attributes.ephemeral_storage_gb_hourly = String(storagePrice);
      attributes.sku_id_storage = storageSku.skuId;
    }

    return {
      provider: "gcp",
      service: "gke",
      resource_type: "autopilot-pod",
      region,
      unit: "h",
      price_per_unit: vcpuPrice,
      currency: "USD",
      description: `GCP GKE Autopilot pod resources (live: ${vcpuSku.description})`,
      attributes,
      effective_date: vcpuSku.pricingInfo?.[0]?.effectiveTime ?? new Date().toISOString(),
    };
  }
}
