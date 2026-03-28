import type { NormalizedPrice } from "../../types/pricing.js";
import type { PricingCache } from "../cache.js";
import type { AzureRetailPriceItem, AzureRetailPriceResponse } from "./types.js";
import { logger } from "../../logger.js";
import {
  normalizeAzureCompute,
  normalizeAzureDatabase,
  normalizeAzureStorage,
} from "./azure-normalizer.js";
import { fetchWithRetryAndCircuitBreaker } from "../fetch-utils.js";
import { interpolateByVcpuRatio } from "../interpolation.js";
import {
  VM_BASE_PRICES,
  DISK_BASE_PRICES,
  DB_BASE_PRICES,
  ALB_HOURLY,
  ALB_RULE_HOURLY,
  NAT_HOURLY,
  NAT_PER_GB,
  AKS_HOURLY,
  CACHE_TTL,
  RETAIL_API_BASE,
  regionMultiplier,
} from "./fallback-data.js";

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
    os: string = "linux",
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
    engine: string = "PostgreSQL",
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
    serviceName: string,
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
      exactItems.sort((a, b) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
      // Pick a per-hour compute entry (not storage)
      const match =
        exactItems.find((i) => (i.meterName ?? "").toLowerCase().includes("vcore")) ??
        exactItems[0];
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
      seriesItems.sort((a, b) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
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
  private parseVmSeries(vmName: string): { series: string; vcpus: number } | null {
    // Match patterns like Standard_D2s_v3, Standard_E4ds_v5, Standard_D16ads_v5
    const match = vmName.match(/Standard_([A-Z])(\d+)([a-z]*)_v(\d+)/i);
    if (!match) return null;

    const [, family, vcpuStr, variant, version] = match;
    const vcpus = parseInt(vcpuStr, 10);
    if (isNaN(vcpus) || vcpus === 0) return null;

    // Build series name: D + variant-without-count + v + version
    // e.g., D2s_v3 → Dsv3, E4ds_v5 → Edsv5
    const series = `${family}${variant}v${version}`;
    return { series, vcpus };
  }

  async getStoragePrice(diskType: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("disk", region, diskType);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const armRegion = region.toLowerCase().replace(/\s+/g, "");
      const filter = this.buildODataFilter("Storage", armRegion, diskType);
      const items = await this.queryPricing(filter);

      if (items.length > 0) {
        // Sort for deterministic selection across runs
        items.sort((a, b) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));
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

  private async queryPricing(filter: string): Promise<AzureRetailPriceItem[]> {
    const allItems: AzureRetailPriceItem[] = [];
    let url: string | null =
      `${RETAIL_API_BASE}?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`;
    logger.debug("Querying Azure Retail Prices API", { filter });

    let pages = 0;
    while (url && pages < 10) {
      // Use circuit breaker to fast-fail when the endpoint is repeatedly
      // unavailable. Retry once on transient errors but avoid excessive
      // latency since callers already have static fallback pricing.
      const res = await fetchWithRetryAndCircuitBreaker(
        url,
        { signal: AbortSignal.timeout(30_000) },
        { maxRetries: 1, baseDelay: 500, maxDelay: 2_000 },
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from Azure Retail API`);
      }

      const json = (await res.json()) as AzureRetailPriceResponse;
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
    exactArmSku?: boolean,
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

  private buildCacheKey(service: string, region: string, ...parts: string[]): string {
    return ["azure", service, region, ...parts].map((p) => p.toLowerCase()).join("/");
  }

  /**
   * From the API response items, pick the item that best matches the desired
   * VM size and OS.  Prefers exact skuName matches and the correct OS suffix
   * ("Windows" vs everything else being Linux).
   */
  private pickVmItem(
    items: AzureRetailPriceItem[],
    vmSize: string,
    os: string,
  ): AzureRetailPriceItem | null {
    if (items.length === 0) return null;

    // Sort by skuId for deterministic selection across runs
    const sorted = [...items].sort((a, b) => (a.skuId ?? "").localeCompare(b.skuId ?? ""));

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
   *
   * Delegated to the shared `interpolateByVcpuRatio` utility with a VM-specific
   * normaliser that lowercases and collapses whitespace to underscores.
   */
  private interpolateVmPrice(vmSize: string, table: Record<string, number>): number | undefined {
    return interpolateByVcpuRatio(vmSize, table, (name) => name.toLowerCase().replace(/\s+/g, "_"));
  }

  /**
   * Azure DB tier names embed a vCPU number similarly to VM sizes.
   * e.g. "gp_standard_d2s_v3" → "gp_standard_d4s_v3" doubles.
   *
   * Delegated to the shared `interpolateByVcpuRatio` utility with a DB-tier
   * normaliser that also collapses hyphens to underscores.
   */
  private interpolateDbPrice(tier: string, table: Record<string, number>): number | undefined {
    return interpolateByVcpuRatio(tier, table, (name) =>
      name.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_"),
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers – fallback hardcoded prices
  // -------------------------------------------------------------------------

  private fallbackComputePrice(
    vmSize: string,
    region: string,
    os: string,
    cacheKey: string,
  ): NormalizedPrice | null {
    const key = vmSize.toLowerCase().replace(/\s+/g, "_");
    const basePrice: number =
      VM_BASE_PRICES[key] ?? this.interpolateVmPrice(vmSize, VM_BASE_PRICES) ?? NaN;
    if (!isFinite(basePrice)) {
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
    cacheKey: string,
  ): NormalizedPrice | null {
    const key = tier.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
    const basePrice: number =
      DB_BASE_PRICES[key] ?? this.interpolateDbPrice(tier, DB_BASE_PRICES) ?? NaN;
    if (!isFinite(basePrice)) {
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
    cacheKey: string,
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
