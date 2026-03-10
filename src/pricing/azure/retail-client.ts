import type { NormalizedPrice } from "../../types/pricing.js";
import type { PricingCache } from "../cache.js";
import { logger } from "../../logger.js";
import {
  normalizeAzureCompute,
  normalizeAzureDatabase,
  normalizeAzureStorage,
} from "./azure-normalizer.js";
import { fetchWithRetryAndCircuitBreaker } from "../fetch-utils.js";

// ---------------------------------------------------------------------------
// Fallback pricing data (approximate eastus on-demand prices, 2024)
// ---------------------------------------------------------------------------

const VM_BASE_PRICES: Record<string, number> = {
  "standard_b1s": 0.0104,
  "standard_b1ms": 0.0207,
  "standard_b2s": 0.0416,
  "standard_b2ms": 0.0832,
  "standard_b4ms": 0.166,
  "standard_b8ms": 0.333,
  "standard_b12ms": 0.499,
  "standard_b16ms": 0.666,
  "standard_d2s_v4": 0.096,
  "standard_d4s_v4": 0.192,
  "standard_d8s_v4": 0.384,
  "standard_d2s_v5": 0.096,
  "standard_d4s_v5": 0.192,
  "standard_d8s_v5": 0.384,
  "standard_d16s_v5": 0.768,
  "standard_d32s_v5": 1.536,
  "standard_d2ds_v5": 0.113,
  "standard_d4ds_v5": 0.226,
  "standard_d8ds_v5": 0.452,
  "standard_d2ps_v5": 0.077,
  "standard_d4ps_v5": 0.154,
  "standard_e2s_v5": 0.126,
  "standard_e4s_v5": 0.252,
  "standard_e8s_v5": 0.504,
  "standard_e16s_v5": 1.008,
  "standard_e32s_v5": 2.016,
  "standard_e2ds_v5": 0.144,
  "standard_e4ds_v5": 0.288,
  "standard_f2s_v2": 0.085,
  "standard_f4s_v2": 0.170,
  "standard_f8s_v2": 0.340,
  "standard_f16s_v2": 0.680,
  "standard_f32s_v2": 1.360,
  "standard_l8s_v3": 0.624,
  "standard_l16s_v3": 1.248,
  "standard_nc4as_t4_v3": 0.526,
  "standard_nc8as_t4_v3": 0.752,
  "standard_e2ps_v5": 0.101,
  "standard_e4ps_v5": 0.202,
  "standard_e8ps_v5": 0.403,
};

// Disk prices are per GB/month
const DISK_BASE_PRICES: Record<string, number> = {
  "premium_lrs": 0.132,
  "standard_lrs": 0.04,
  "standardssd_lrs": 0.075,
  "ultrassd_lrs": 0.12,
  "premium_lrs_p10": 0.0052,
  "premium_lrs_p20": 0.0100,
  "premium_lrs_p30": 0.0192,
  "premium_lrs_p40": 0.0373,
};

// Azure DB for PostgreSQL Flexible prices (per hour)
const DB_BASE_PRICES: Record<string, number> = {
  "burstable_standard_b1ms": 0.044,
  "burstable_standard_b2s": 0.088,
  "burstable_standard_b4ms": 0.176,
  "gp_standard_d2s_v3": 0.124,
  "gp_standard_d4s_v3": 0.248,
  "gp_standard_d8s_v3": 0.496,
  "gp_standard_d16s_v3": 0.992,
  "gp_standard_d2ds_v4": 0.124,
  "gp_standard_d4ds_v4": 0.248,
  "gp_standard_d8ds_v4": 0.496,
  "gp_standard_d16ds_v4": 0.992,
  "mo_standard_e2ds_v4": 0.170,
  "mo_standard_e4ds_v4": 0.341,
  "mo_standard_e8ds_v4": 0.682,
};

// ALB (Azure Load Balancer) pricing
const ALB_HOURLY = 0.025;
const ALB_RULE_HOURLY = 0.005;

// Azure NAT Gateway pricing
const NAT_HOURLY = 0.045;
const NAT_PER_GB = 0.045;

// AKS control plane (paid tier with uptime SLA)
const AKS_HOURLY = 0.10;

// ---------------------------------------------------------------------------
// Regional multipliers relative to eastus
// ---------------------------------------------------------------------------

const REGION_MULTIPLIERS: Record<string, number> = {
  eastus: 1.0,
  eastus2: 1.0,
  westus: 1.05,
  westus2: 1.0,
  westus3: 1.02,
  centralus: 1.0,
  northeurope: 1.08,
  westeurope: 1.08,
  uksouth: 1.08,
  ukwest: 1.12,
  southeastasia: 1.12,
  eastasia: 1.12,
  japaneast: 1.10,
  japanwest: 1.12,
  australiaeast: 1.15,
  brazilsouth: 1.25,
  canadacentral: 1.05,
  southafricanorth: 1.15,
  germanywestcentral: 1.10,
  centralindia: 1.08,
  koreacentral: 1.10,
  swedencentral: 1.08,
  italynorth: 1.10,
  uaenorth: 1.12,
};

function regionMultiplier(region: string): number {
  return REGION_MULTIPLIERS[region.toLowerCase()] ?? 1.0;
}

const CACHE_TTL = 86400; // 24 hours

const RETAIL_API_BASE = "https://prices.azure.com/api/retail/prices";

export class AzureRetailClient {
  private cache: PricingCache;

  constructor(cache: PricingCache) {
    this.cache = cache;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async getComputePrice(
    vmSize: string,
    region: string,
    os: string = "linux"
  ): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("vm", region, vmSize, os);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      // OData filter: serviceName eq 'Virtual Machines', armRegionName eq '{region}',
      // skuName contains vmSize, priceType eq 'Consumption'
      const armRegion = region.toLowerCase().replace(/\s+/g, "");
      const filter = this.buildODataFilter("Virtual Machines", armRegion, vmSize, true);
      const items = await this.queryPricing(filter);

      // Pick the best match: prefer the one that's exactly the right OS
      const match = this.pickVmItem(items, vmSize, os);
      if (match) {
        const result = normalizeAzureCompute(match);
        this.cache.set(cacheKey, result, "azure", "vm", region, CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.warn("Azure Retail API VM fetch failed, using fallback", {
        region,
        vmSize,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.fallbackComputePrice(vmSize, region, os, cacheKey);
  }

  async getDatabasePrice(
    tier: string,
    region: string,
    engine: string = "PostgreSQL"
  ): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("db", region, tier, engine);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const armRegion = region.toLowerCase().replace(/\s+/g, "");
      const serviceName = `Azure Database for ${engine}`;
      const result = await this.queryDatabasePrice(tier, armRegion, serviceName);

      if (result) {
        this.cache.set(cacheKey, result, "azure", "db", region, CACHE_TTL);
        return result;
      }

      logger.warn("Azure Retail API returned no matching DB pricing", {
        region,
        tier,
        engine,
      });
    } catch (err) {
      logger.warn("Azure Retail API DB fetch failed, using fallback", {
        region,
        tier,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.fallbackDatabasePrice(tier, region, engine, cacheKey);
  }

  /**
   * Azure DB flexible server tier names follow the pattern:
   *   GP_Standard_D2s_v3  →  General Purpose, D-series, 2 vCPUs, v3
   *   MO_Standard_E4ds_v5 →  Memory Optimized, E-series, 4 vCPUs, v5
   *
   * The Retail API prices DB compute in two ways:
   *   1. Per-instance entries with armSkuName like "Standard_D2ds_v5" (total price)
   *   2. Per-vCore entries for a series (e.g., Dsv3Series_Compute) × vCPU count
   *
   * This method tries approach 1 first, then falls back to approach 2.
   */
  private async queryDatabasePrice(
    tier: string,
    armRegion: string,
    serviceName: string
  ): Promise<NormalizedPrice | null> {
    // Strip service tier prefix: GP_Standard_D2s_v3 → Standard_D2s_v3
    const vmName = tier.replace(/^(GP|MO|BC|GEN)_/i, "");

    // Approach 1: exact armSkuName match (works for newer v5 entries)
    const exactFilter =
      `serviceName eq '${serviceName}' and armRegionName eq '${armRegion}'` +
      ` and priceType eq 'Consumption' and armSkuName eq '${vmName}'`;
    const exactItems = await this.queryPricing(exactFilter);
    if (exactItems.length > 0) {
      // Sort for deterministic selection across runs
      exactItems.sort((a: any, b: any) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
      // Pick a per-hour compute entry (not storage)
      const match = exactItems.find(
        (i: any) => (i.meterName ?? "").toLowerCase().includes("vcore")
      ) ?? exactItems[0];
      return normalizeAzureDatabase(match);
    }

    // Approach 2: per-vCore series lookup
    // Extract vCPU count and series from VM name: Standard_D2s_v3 → { family: D, count: 2, series: Dsv3 }
    const parsed = this.parseVmSeries(vmName);
    if (!parsed) return null;

    const tierPrefix = tier.match(/^(GP|MO|BC|GEN)_/i)?.[1]?.toUpperCase();
    const seriesFamily = tierPrefix === "MO" ? "Memory_Optimized" : "General_Purpose";

    // Search by series pattern in armSkuName
    const seriesFilter =
      `serviceName eq '${serviceName}' and armRegionName eq '${armRegion}'` +
      ` and priceType eq 'Consumption' and contains(armSkuName, '${seriesFamily}')` +
      ` and contains(armSkuName, '${parsed.series}')`;
    const seriesItems = await this.queryPricing(seriesFilter);

    if (seriesItems.length > 0) {
      // Sort for deterministic selection across runs
      seriesItems.sort((a: any, b: any) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
      // These are per-vCore prices — multiply by vCPU count
      const perVcore = seriesItems[0].retailPrice ?? 0;
      const totalPrice = perVcore * parsed.vcpus;
      const adjusted = { ...seriesItems[0], retailPrice: totalPrice };
      return normalizeAzureDatabase(adjusted);
    }

    return null;
  }

  /**
   * Parse a VM name like "Standard_D2s_v3" into series info.
   * Returns { series: "Dsv3", vcpus: 2 } or null if unparseable.
   */
  private parseVmSeries(
    vmName: string
  ): { series: string; vcpus: number } | null {
    // Match patterns like Standard_D2s_v3, Standard_E4ds_v5, Standard_D16ads_v5
    const match = vmName.match(
      /Standard_([A-Z])(\d+)([a-z]*)_v(\d+)/i
    );
    if (!match) return null;

    const [, family, vcpuStr, variant, version] = match;
    const vcpus = parseInt(vcpuStr, 10);
    if (isNaN(vcpus) || vcpus === 0) return null;

    // Build series name: D + variant-without-count + v + version
    // e.g., D2s_v3 → Dsv3, E4ds_v5 → Edsv5
    const series = `${family}${variant}v${version}`;
    return { series, vcpus };
  }

  async getStoragePrice(
    diskType: string,
    region: string
  ): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("disk", region, diskType);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const armRegion = region.toLowerCase().replace(/\s+/g, "");
      const filter = this.buildODataFilter("Storage", armRegion, diskType);
      const items = await this.queryPricing(filter);

      if (items.length > 0) {
        // Sort for deterministic selection across runs
        items.sort((a: any, b: any) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
        const result = normalizeAzureStorage(items[0]);
        this.cache.set(cacheKey, result, "azure", "storage", region, CACHE_TTL);
        return result;
      }

      logger.warn("Azure Retail API returned no matching storage pricing", {
        region,
        diskType,
      });
    } catch (err) {
      logger.warn("Azure Retail API storage fetch failed, using fallback", {
        region,
        diskType,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.fallbackStoragePrice(diskType, region, cacheKey);
  }

  async getLoadBalancerPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "azure",
      service: "load-balancer",
      resource_type: "standard",
      region,
      unit: "1 Hour",
      price_per_unit: ALB_HOURLY * multiplier,
      currency: "USD",
      description: "Azure Load Balancer Standard (hourly + per rule)",
      attributes: {
        rule_hourly_price: String(ALB_RULE_HOURLY * multiplier),
        pricing_model: "fixed_plus_rules",
      },
      effective_date: new Date().toISOString(),
    };
  }

  async getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "azure",
      service: "nat-gateway",
      resource_type: "nat-gateway",
      region,
      unit: "1 Hour",
      price_per_unit: NAT_HOURLY * multiplier,
      currency: "USD",
      description: "Azure NAT Gateway (hourly + data processed)",
      attributes: {
        per_gb_price: String(NAT_PER_GB * multiplier),
      },
      effective_date: new Date().toISOString(),
    };
  }

  async getKubernetesPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "azure",
      service: "aks",
      resource_type: "cluster",
      region,
      unit: "1 Hour",
      price_per_unit: AKS_HOURLY * multiplier,
      currency: "USD",
      description: "Azure Kubernetes Service (uptime SLA tier, per cluster/hour)",
      attributes: {},
      effective_date: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers – live API
  // -------------------------------------------------------------------------

  private async queryPricing(filter: string): Promise<any[]> {
    const allItems: any[] = [];
    let url: string | null = `${RETAIL_API_BASE}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
    logger.debug("Querying Azure Retail Prices API", { filter });

    let pages = 0;
    while (url && pages < 10) {
      // Use circuit breaker to fast-fail when the endpoint is repeatedly
      // unavailable. Retry once on transient errors but avoid excessive
      // latency since callers already have static fallback pricing.
      const res = await fetchWithRetryAndCircuitBreaker(
        url,
        { signal: AbortSignal.timeout(30_000) },
        { maxRetries: 1, baseDelay: 500, maxDelay: 2_000 }
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from Azure Retail API`);
      }

      const json: any = await res.json();
      allItems.push(...(json?.Items ?? []));
      url = json?.NextPageLink ?? null;
      pages++;
    }

    return allItems;
  }

  private buildODataFilter(
    service: string,
    armRegion: string,
    skuName?: string,
    exactArmSku?: boolean
  ): string {
    let filter = `serviceName eq '${service}' and armRegionName eq '${armRegion}' and priceType eq 'Consumption'`;
    if (skuName) {
      if (exactArmSku) {
        filter += ` and armSkuName eq '${skuName}'`;
      } else {
        filter += ` and contains(skuName, '${skuName}')`;
      }
    }
    return filter;
  }

  private buildCacheKey(
    service: string,
    region: string,
    ...parts: string[]
  ): string {
    return ["azure", service, region, ...parts]
      .map((p) => p.toLowerCase())
      .join("/");
  }

  /**
   * From the API response items, pick the item that best matches the desired
   * VM size and OS.  Prefers exact skuName matches and the correct OS suffix
   * ("Windows" vs everything else being Linux).
   */
  private pickVmItem(items: any[], vmSize: string, os: string): any | null {
    if (items.length === 0) return null;

    // Sort by skuId for deterministic selection across runs
    const sorted = [...items].sort((a, b) =>
      (a.skuId ?? "").localeCompare(b.skuId ?? "")
    );

    const vmLower = vmSize.toLowerCase();
    const isWindows = os.toLowerCase().includes("windows");

    // Prefer exact sku match with the right OS
    for (const item of sorted) {
      const skuLower = (item.skuName ?? "").toLowerCase();
      const hasWindows = skuLower.includes("windows");
      if (
        skuLower.includes(vmLower) &&
        ((isWindows && hasWindows) || (!isWindows && !hasWindows))
      ) {
        return item;
      }
    }

    // Fallback: return the first sorted item
    return sorted[0];
  }

  // -------------------------------------------------------------------------
  // Internal helpers – size interpolation
  // -------------------------------------------------------------------------

  /**
   * Azure VM sizes embed vCPU count as a number: Standard_D2s_v5 → 2 vCPUs.
   * Doubling the number roughly doubles the price. Find the nearest known
   * size in the same family/suffix and scale proportionally.
   */
  private interpolateVmPrice(
    vmSize: string,
    table: Record<string, number>
  ): number | undefined {
    const key = vmSize.toLowerCase().replace(/\s+/g, "_");
    // Match pattern like "standard_d2s_v5" → prefix "standard_d", num 2, suffix "s_v5"
    const match = key.match(/^(.+?)(\d+)(.*?)$/);
    if (!match) return undefined;

    const [, prefix, numStr, suffix] = match;
    const targetNum = parseInt(numStr, 10);
    if (isNaN(targetNum) || targetNum === 0) return undefined;

    let bestKey: string | undefined;
    let bestNum = 0;
    let bestDistance = Infinity;

    for (const candidate of Object.keys(table)) {
      const candMatch = candidate.match(/^(.+?)(\d+)(.*?)$/);
      if (!candMatch) continue;
      const [, cPrefix, cNumStr, cSuffix] = candMatch;
      if (cPrefix !== prefix || cSuffix !== suffix) continue;

      const cNum = parseInt(cNumStr, 10);
      if (isNaN(cNum) || cNum === 0) continue;

      const distance = Math.abs(cNum - targetNum);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestNum = cNum;
        bestKey = candidate;
      }
    }

    if (bestKey === undefined || bestNum === 0) return undefined;
    return table[bestKey]! * (targetNum / bestNum);
  }

  /**
   * Azure DB tier names embed a vCPU number similarly to VM sizes.
   * e.g. "gp_standard_d2s_v3" → "gp_standard_d4s_v3" doubles.
   */
  private interpolateDbPrice(
    tier: string,
    table: Record<string, number>
  ): number | undefined {
    const key = tier.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
    const match = key.match(/^(.+?)(\d+)(.*?)$/);
    if (!match) return undefined;

    const [, prefix, numStr, suffix] = match;
    const targetNum = parseInt(numStr, 10);
    if (isNaN(targetNum) || targetNum === 0) return undefined;

    let bestKey: string | undefined;
    let bestNum = 0;
    let bestDistance = Infinity;

    for (const candidate of Object.keys(table)) {
      const candMatch = candidate.match(/^(.+?)(\d+)(.*?)$/);
      if (!candMatch) continue;
      const [, cPrefix, cNumStr, cSuffix] = candMatch;
      if (cPrefix !== prefix || cSuffix !== suffix) continue;

      const cNum = parseInt(cNumStr, 10);
      if (isNaN(cNum) || cNum === 0) continue;

      const distance = Math.abs(cNum - targetNum);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestNum = cNum;
        bestKey = candidate;
      }
    }

    if (bestKey === undefined || bestNum === 0) return undefined;
    return table[bestKey]! * (targetNum / bestNum);
  }

  // -------------------------------------------------------------------------
  // Internal helpers – fallback hardcoded prices
  // -------------------------------------------------------------------------

  private fallbackComputePrice(
    vmSize: string,
    region: string,
    os: string,
    cacheKey: string
  ): NormalizedPrice | null {
    const key = vmSize.toLowerCase().replace(/\s+/g, "_");
    let basePrice = VM_BASE_PRICES[key];
    if (basePrice === undefined) {
      basePrice = this.interpolateVmPrice(vmSize, VM_BASE_PRICES) ?? undefined as any;
    }
    if (basePrice === undefined) {
      logger.warn("No fallback price found for Azure VM size", { vmSize });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "azure",
      service: "virtual-machines",
      resource_type: vmSize,
      region,
      unit: "1 Hour",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `Azure VM ${vmSize} (${os}) – fallback pricing`,
      attributes: {
        sku_name: vmSize,
        operating_system: os,
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "azure", "vm", region, CACHE_TTL);
    return result;
  }

  private fallbackDatabasePrice(
    tier: string,
    region: string,
    engine: string,
    cacheKey: string
  ): NormalizedPrice | null {
    const key = tier.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
    let basePrice = DB_BASE_PRICES[key];
    if (basePrice === undefined) {
      basePrice = this.interpolateDbPrice(tier, DB_BASE_PRICES) ?? undefined as any;
    }
    if (basePrice === undefined) {
      logger.warn("No fallback price found for Azure DB tier", { tier });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "azure",
      service: "azure-database",
      resource_type: tier,
      region,
      unit: "1 Hour",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `Azure Database for ${engine} ${tier} – fallback pricing`,
      attributes: {
        tier,
        engine,
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "azure", "db", region, CACHE_TTL);
    return result;
  }

  private fallbackStoragePrice(
    diskType: string,
    region: string,
    cacheKey: string
  ): NormalizedPrice | null {
    const key = diskType.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
    const basePrice = DISK_BASE_PRICES[key];
    if (basePrice === undefined) {
      logger.warn("No fallback price found for Azure disk type", { diskType });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "azure",
      service: "managed-disks",
      resource_type: diskType,
      region,
      unit: "1 GiB/Month",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `Azure Managed Disk ${diskType} – fallback pricing`,
      attributes: {
        disk_type: diskType,
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "azure", "storage", region, CACHE_TTL);
    return result;
  }
}
