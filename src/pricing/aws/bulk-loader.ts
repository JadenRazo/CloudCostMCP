import type { NormalizedPrice } from "../../types/pricing.js";
import type { PricingCache } from "../cache.js";
import type { AwsBulkPricingResponse } from "./types.js";
import { logger } from "../../logger.js";
import {
  normalizeAwsCompute,
  normalizeAwsDatabase,
  normalizeAwsStorage,
} from "./aws-normalizer.js";
import { fetchWithRetryAndCircuitBreaker } from "../fetch-utils.js";
import { interpolateByStepOrder } from "../interpolation.js";
import { parseCsvLine } from "./csv-parser.js";
import {
  EC2_BASE_PRICES,
  RDS_BASE_PRICES,
  EBS_BASE_PRICES,
  ALB_HOURLY,
  ALB_LCU_HOURLY,
  NAT_HOURLY,
  NAT_PER_GB,
  EKS_HOURLY,
  CACHE_TTL,
  BULK_PRICING_BASE,
  SIZE_ORDER,
  regionMultiplier,
} from "./fallback-data.js";

export class AwsBulkLoader {
  private cache: PricingCache;

  /**
   * Deduplicates concurrent streaming CSV fetches for the same region.
   * Keyed by region; value is the in-flight Promise<boolean>.
   */
  private ec2CsvFetchInProgress: Map<string, Promise<boolean>> = new Map();

  constructor(cache: PricingCache) {
    this.cache = cache;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async getComputePrice(
    instanceType: string,
    region: string,
    os: string = "Linux",
  ): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("ec2", region, instanceType, os);

    // Step 1: cache hit
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    // Step 2: stream the CSV pricing file for this region (fast, ~267 MB, line-by-line)
    try {
      const csvOk = await this.fetchAndCacheEc2CsvPrices(region);
      if (csvOk) {
        const afterCsv = this.cache.get<NormalizedPrice>(cacheKey);
        if (afterCsv) return afterCsv;
      }
    } catch (err) {
      logger.warn("AWS EC2 CSV streaming failed", {
        region,
        instanceType,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 3: fall back to JSON bulk API (kept for non-EC2 service compatibility)
    try {
      const bulk = await this.fetchBulkPricing("AmazonEC2", region);
      if (bulk) {
        const result = this.extractEc2Price(bulk, instanceType, region, os);
        if (result) {
          this.cache.set(cacheKey, result, "aws", "ec2", region, CACHE_TTL);
          return result;
        }
      }
    } catch (err) {
      logger.warn("AWS bulk EC2 JSON fetch failed, using fallback", {
        region,
        instanceType,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 4: hardcoded tables + size interpolation
    return this.fallbackComputePrice(instanceType, region, os, cacheKey);
  }

  async getDatabasePrice(
    instanceClass: string,
    region: string,
    engine: string = "MySQL",
  ): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("rds", region, instanceClass, engine);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const bulk = await this.fetchBulkPricing("AmazonRDS", region);
      if (bulk) {
        const result = this.extractRdsPrice(bulk, instanceClass, region, engine);
        if (result) {
          this.cache.set(cacheKey, result, "aws", "rds", region, CACHE_TTL);
          return result;
        }
      }
    } catch (err) {
      logger.warn("AWS bulk RDS fetch failed, using fallback", {
        region,
        instanceClass,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.fallbackDatabasePrice(instanceClass, region, engine, cacheKey);
  }

  async getStoragePrice(volumeType: string, region: string): Promise<NormalizedPrice | null> {
    const cacheKey = this.buildCacheKey("ebs", region, volumeType);
    const cached = this.cache.get<NormalizedPrice>(cacheKey);
    if (cached) return cached;

    try {
      const bulk = await this.fetchBulkPricing("AmazonEC2", region);
      if (bulk) {
        const result = this.extractEbsPrice(bulk, volumeType, region);
        if (result) {
          this.cache.set(cacheKey, result, "aws", "ebs", region, CACHE_TTL);
          return result;
        }
      }
    } catch (err) {
      logger.warn("AWS bulk EBS fetch failed, using fallback", {
        region,
        volumeType,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return this.fallbackStoragePrice(volumeType, region, cacheKey);
  }

  async getLoadBalancerPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "aws",
      service: "elb",
      resource_type: "alb",
      region,
      unit: "Hrs",
      price_per_unit: ALB_HOURLY * multiplier,
      currency: "USD",
      description: "AWS Application Load Balancer (hourly fixed charge)",
      attributes: {
        lcu_hourly_price: String(ALB_LCU_HOURLY * multiplier),
        pricing_model: "fixed_plus_lcu",
      },
      effective_date: new Date().toISOString(),
    };
  }

  async getNatGatewayPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "aws",
      service: "vpc",
      resource_type: "nat-gateway",
      region,
      unit: "Hrs",
      price_per_unit: NAT_HOURLY * multiplier,
      currency: "USD",
      description: "AWS NAT Gateway (hourly charge + data processing)",
      attributes: {
        per_gb_price: String(NAT_PER_GB * multiplier),
      },
      effective_date: new Date().toISOString(),
    };
  }

  async getKubernetesPrice(region: string): Promise<NormalizedPrice | null> {
    const multiplier = regionMultiplier(region);
    return {
      provider: "aws",
      service: "eks",
      resource_type: "cluster",
      region,
      unit: "Hrs",
      price_per_unit: EKS_HOURLY * multiplier,
      currency: "USD",
      description: "AWS EKS control plane (per cluster/hour)",
      attributes: {},
      effective_date: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers – EC2 CSV streaming
  // -------------------------------------------------------------------------

  /**
   * Fetch the per-region EC2 pricing CSV from the AWS Bulk Pricing endpoint,
   * stream it line-by-line, parse every "Compute Instance / OnDemand / Shared"
   * row for ALL operating systems, and write each extracted price into the
   * SQLite cache.
   *
   * The CSV URL pattern is:
   *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/{region}/index.csv
   *
   * The first ~5 rows of the file are metadata (FormatVersion, Disclaimer,
   * Publication Date, etc.).  The actual header row is the first row whose
   * first field is "SKU".
   *
   * Returns true when at least one price was extracted and cached.
   */
  private fetchAndCacheEc2CsvPrices(region: string): Promise<boolean> {
    // Deduplicate concurrent requests for the same region
    const inflight = this.ec2CsvFetchInProgress.get(region);
    if (inflight) return inflight;

    const promise = this._doFetchAndCacheEc2CsvPrices(region).finally(() => {
      this.ec2CsvFetchInProgress.delete(region);
    });

    this.ec2CsvFetchInProgress.set(region, promise);
    return promise;
  }

  private async _doFetchAndCacheEc2CsvPrices(region: string): Promise<boolean> {
    const url = `${BULK_PRICING_BASE}/AmazonEC2/current/${region}/index.csv`;
    logger.debug("Streaming AWS EC2 CSV pricing", { url, region });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetchWithRetryAndCircuitBreaker(
        url,
        { signal: controller.signal },
        {
          maxRetries: 1,
          baseDelay: 500,
          maxDelay: 2_000,
        },
      );
      if (!res.ok) {
        logger.debug("AWS EC2 CSV fetch returned non-OK status", {
          region,
          status: res.status,
        });
        return false;
      }

      if (!res.body) {
        logger.debug("AWS EC2 CSV response has no body", { region });
        return false;
      }

      // Stream the response body through a TextDecoder so we work with strings
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

      // Open a single SQLite transaction for all cache.set() calls during this
      // CSV stream. AWS EC2 CSVs contain 1000+ rows; batching yields ~100x
      // write throughput compared to individual auto-commit transactions.
      this.cache.beginBatch();

      // Column indices discovered from the header row
      let colInstanceType = -1;
      let colOS = -1;
      let colTenancy = -1;
      let colTermType = -1;
      let colCapacityStatus = -1;
      let colProductFamily = -1;
      let colPrice = -1;
      let colUnit = -1;

      let headerFound = false;
      let leftover = "";
      let cachedCount = 0;
      const effectiveDate = new Date().toISOString();

      // Process the stream chunk-by-chunk, splitting on newlines
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = leftover + value;
        const lines = chunk.split("\n");
        // The last element may be an incomplete line – carry it over
        leftover = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd(); // remove \r if CRLF
          if (!line) continue;

          if (!headerFound) {
            // Metadata rows look like: "FormatVersion","1.0"
            // The real header starts with "SKU"
            if (line.startsWith('"SKU"') || line.startsWith("SKU")) {
              const headers = parseCsvLine(line);
              for (let h = 0; h < headers.length; h++) {
                const name = headers[h]!.trim();
                if (name === "Instance Type") colInstanceType = h;
                else if (name === "Operating System") colOS = h;
                else if (name === "Tenancy") colTenancy = h;
                else if (name === "TermType") colTermType = h;
                else if (name === "Capacity Status") colCapacityStatus = h;
                else if (name === "Product Family") colProductFamily = h;
                else if (name === "PricePerUnit" || name === "Price Per Unit") colPrice = h;
                else if (name === "Unit") colUnit = h;
              }

              // Only proceed if we found the minimum required columns
              if (colInstanceType === -1 || colOS === -1 || colPrice === -1) {
                logger.debug("AWS EC2 CSV header missing required columns", {
                  region,
                  colInstanceType,
                  colOS,
                  colPrice,
                });
                this.cache.rollbackBatch();
                return false;
              }

              headerFound = true;
            }
            continue; // metadata row – skip
          }

          // Quick pre-filter before expensive CSV parsing
          if (!line.includes("OnDemand") || !line.includes("Compute Instance")) {
            continue;
          }

          const fields = parseCsvLine(line);

          // Apply filters for the rows we care about
          if (colProductFamily !== -1) {
            const pf = fields[colProductFamily] ?? "";
            if (pf !== "Compute Instance") continue;
          }
          if (colTenancy !== -1) {
            const tenancy = fields[colTenancy] ?? "";
            if (tenancy !== "Shared") continue;
          }
          if (colTermType !== -1) {
            const termType = fields[colTermType] ?? "";
            if (termType !== "OnDemand") continue;
          }
          if (colCapacityStatus !== -1) {
            const cap = fields[colCapacityStatus] ?? "";
            if (cap !== "Used") continue;
          }

          const instanceType = fields[colInstanceType] ?? "";
          const os = fields[colOS] ?? "";
          const rawPrice = fields[colPrice] ?? "";
          const unit = colUnit !== -1 ? (fields[colUnit] ?? "Hrs") : "Hrs";

          if (!instanceType || !os || !rawPrice) continue;

          const priceValue = parseFloat(rawPrice);
          if (!isFinite(priceValue) || priceValue <= 0) continue;

          const csvCacheKey = `aws/ec2/${region}/${instanceType.toLowerCase()}/${os.toLowerCase()}`;

          const normalized: NormalizedPrice = {
            provider: "aws",
            service: "ec2",
            resource_type: instanceType,
            region,
            unit,
            price_per_unit: priceValue,
            currency: "USD",
            description: `AWS EC2 ${instanceType} (${os}) on-demand`,
            attributes: {
              instance_type: instanceType,
              operating_system: os,
              tenancy: "Shared",
              pricing_source: "live",
            },
            effective_date: effectiveDate,
          };

          this.cache.set(csvCacheKey, normalized, "aws", "ec2", region, CACHE_TTL);
          cachedCount++;
        }
      }

      // Handle any remaining partial line
      if (leftover.trim() && headerFound) {
        const line = leftover.trimEnd();
        if (line.includes("OnDemand") && line.includes("Compute Instance")) {
          const fields = parseCsvLine(line);
          const instanceType = fields[colInstanceType] ?? "";
          const os = fields[colOS] ?? "";
          const rawPrice = fields[colPrice] ?? "";
          const unit = colUnit !== -1 ? (fields[colUnit] ?? "Hrs") : "Hrs";
          const priceValue = parseFloat(rawPrice);

          if (instanceType && os && isFinite(priceValue) && priceValue > 0) {
            const csvCacheKey = `aws/ec2/${region}/${instanceType.toLowerCase()}/${os.toLowerCase()}`;
            this.cache.set(
              csvCacheKey,
              {
                provider: "aws",
                service: "ec2",
                resource_type: instanceType,
                region,
                unit,
                price_per_unit: priceValue,
                currency: "USD",
                description: `AWS EC2 ${instanceType} (${os}) on-demand`,
                attributes: {
                  instance_type: instanceType,
                  operating_system: os,
                  tenancy: "Shared",
                  pricing_source: "live",
                },
                effective_date: new Date().toISOString(),
              } satisfies NormalizedPrice,
              "aws",
              "ec2",
              region,
              CACHE_TTL,
            );
            cachedCount++;
          }
        }
      }

      // Commit or discard the batch transaction
      if (cachedCount > 0) {
        this.cache.endBatch();
      } else {
        // Nothing written — roll back the empty transaction cleanly
        this.cache.rollbackBatch();
      }

      logger.debug("AWS EC2 CSV streaming complete", { region, cachedCount });
      return cachedCount > 0;
    } catch (err) {
      // Roll back any partial batch on error to avoid partial cache state
      this.cache.rollbackBatch();

      if ((err as Error)?.name === "AbortError") {
        logger.debug("AWS EC2 CSV streaming timed out", { region });
      } else {
        logger.debug("AWS EC2 CSV streaming error", {
          region,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers – live API fetch
  // -------------------------------------------------------------------------

  private async fetchBulkPricing(
    service: string,
    region: string,
  ): Promise<AwsBulkPricingResponse | null> {
    const url = `${BULK_PRICING_BASE}/${service}/current/${region}/index.json`;
    logger.debug("Fetching AWS bulk pricing", { url });

    // Use circuit breaker but no retry here — the caller already has a
    // fallback chain (CSV → JSON → hardcoded). Retrying the JSON bulk fetch
    // would add excessive latency when the live API is unavailable.
    const res = await fetchWithRetryAndCircuitBreaker(
      url,
      {
        signal: AbortSignal.timeout(30_000),
      },
      { maxRetries: 0 },
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    return (await res.json()) as AwsBulkPricingResponse;
  }

  private buildCacheKey(service: string, region: string, ...parts: string[]): string {
    return ["aws", service, region, ...parts].map((p) => p.toLowerCase()).join("/");
  }

  // -------------------------------------------------------------------------
  // Internal helpers – extract prices from bulk JSON
  // -------------------------------------------------------------------------

  private extractEc2Price(
    bulk: AwsBulkPricingResponse,
    instanceType: string,
    region: string,
    os: string,
  ): NormalizedPrice | null {
    const products = bulk?.products ?? {};
    const onDemand = bulk?.terms?.OnDemand ?? {};

    // Sort by SKU for deterministic selection when multiple entries match
    const sortedEntries = Object.entries(products).sort(([a], [b]) => a.localeCompare(b));

    for (const [sku, product] of sortedEntries) {
      const attrs = product?.attributes ?? {};
      if (
        attrs.instanceType === instanceType &&
        (attrs.operatingSystem ?? "").toLowerCase() === os.toLowerCase() &&
        attrs.tenancy === "Shared" &&
        attrs.capacitystatus === "Used"
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsCompute(
            product,
            { terms: { OnDemand: { [sku]: priceTerms } } },
            region,
          );
        }
      }
    }
    return null;
  }

  private extractRdsPrice(
    bulk: AwsBulkPricingResponse,
    instanceClass: string,
    region: string,
    engine: string,
  ): NormalizedPrice | null {
    const products = bulk?.products ?? {};
    const onDemand = bulk?.terms?.OnDemand ?? {};

    // Sort by SKU for deterministic selection when multiple entries match
    const sortedEntries = Object.entries(products).sort(([a], [b]) => a.localeCompare(b));

    for (const [sku, product] of sortedEntries) {
      const attrs = product?.attributes ?? {};
      if (
        attrs.instanceType === instanceClass &&
        (attrs.databaseEngine ?? "").toLowerCase().includes(engine.toLowerCase()) &&
        attrs.deploymentOption === "Single-AZ"
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsDatabase(
            product,
            { terms: { OnDemand: { [sku]: priceTerms } } },
            region,
          );
        }
      }
    }
    return null;
  }

  private extractEbsPrice(
    bulk: AwsBulkPricingResponse,
    volumeType: string,
    region: string,
  ): NormalizedPrice | null {
    const products = bulk?.products ?? {};
    const onDemand = bulk?.terms?.OnDemand ?? {};

    // Sort by SKU for deterministic selection when multiple entries match
    const sortedEntries = Object.entries(products).sort(([a], [b]) => a.localeCompare(b));

    for (const [sku, product] of sortedEntries) {
      const attrs = product?.attributes ?? {};
      const apiName = (attrs.volumeApiName ?? "").toLowerCase();
      if (
        product?.productFamily === "Storage" &&
        (apiName === volumeType.toLowerCase() ||
          (attrs.volumeType ?? "").toLowerCase() === volumeType.toLowerCase())
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsStorage(
            product,
            { terms: { OnDemand: { [sku]: priceTerms } } },
            region,
          );
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers – fallback hardcoded prices
  // -------------------------------------------------------------------------

  private fallbackComputePrice(
    instanceType: string,
    region: string,
    os: string,
    cacheKey: string,
  ): NormalizedPrice | null {
    const basePrice: number =
      EC2_BASE_PRICES[instanceType.toLowerCase()] ??
      interpolateByStepOrder(instanceType, EC2_BASE_PRICES, SIZE_ORDER) ??
      NaN;
    if (!isFinite(basePrice)) {
      logger.warn("No fallback price found for EC2 instance type", { instanceType });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "aws",
      service: "ec2",
      resource_type: instanceType,
      region,
      unit: "Hrs",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `AWS EC2 ${instanceType} (${os}) – fallback pricing`,
      attributes: {
        instance_type: instanceType,
        operating_system: os,
        tenancy: "Shared",
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "aws", "ec2", region, CACHE_TTL);
    return result;
  }

  private fallbackDatabasePrice(
    instanceClass: string,
    region: string,
    engine: string,
    cacheKey: string,
  ): NormalizedPrice | null {
    const basePrice: number =
      RDS_BASE_PRICES[instanceClass.toLowerCase()] ??
      interpolateByStepOrder(instanceClass, RDS_BASE_PRICES, SIZE_ORDER) ??
      NaN;
    if (!isFinite(basePrice)) {
      logger.warn("No fallback price found for RDS instance class", { instanceClass });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "aws",
      service: "rds",
      resource_type: instanceClass,
      region,
      unit: "Hrs",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `AWS RDS ${instanceClass} (${engine}) – fallback pricing`,
      attributes: {
        instance_type: instanceClass,
        database_engine: engine,
        deployment_option: "Single-AZ",
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "aws", "rds", region, CACHE_TTL);
    return result;
  }

  private fallbackStoragePrice(
    volumeType: string,
    region: string,
    cacheKey: string,
  ): NormalizedPrice | null {
    const basePrice = EBS_BASE_PRICES[volumeType.toLowerCase()];
    if (basePrice === undefined) {
      logger.warn("No fallback price found for EBS volume type", { volumeType });
      return null;
    }

    const multiplier = regionMultiplier(region);
    const result: NormalizedPrice = {
      provider: "aws",
      service: "ebs",
      resource_type: volumeType,
      region,
      unit: "GB-Mo",
      price_per_unit: basePrice * multiplier,
      currency: "USD",
      description: `AWS EBS ${volumeType} volume – fallback pricing`,
      attributes: {
        volume_type: volumeType,
        pricing_source: "fallback",
      },
      effective_date: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result, "aws", "ebs", region, CACHE_TTL);
    return result;
  }
}
