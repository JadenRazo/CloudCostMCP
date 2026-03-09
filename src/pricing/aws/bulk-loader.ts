import type { NormalizedPrice } from "../../types/pricing.js";
import type { PricingCache } from "../cache.js";
import { logger } from "../../logger.js";
import {
  normalizeAwsCompute,
  normalizeAwsDatabase,
  normalizeAwsStorage,
} from "./aws-normalizer.js";

// ---------------------------------------------------------------------------
// CSV parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line into an array of fields. Handles:
 *   - Fields wrapped in double-quotes
 *   - Embedded commas inside quoted fields
 *   - Escaped double-quotes represented as two consecutive double-quotes ("")
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const len = line.length;

  while (i <= len) {
    if (i === len) {
      // Trailing empty field after a terminal comma
      if (fields.length > 0 && line[len - 1] === ",") {
        fields.push("");
      }
      break;
    }

    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            // Escaped double-quote
            field += '"';
            i += 2;
          } else {
            // Closing quote
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // Skip the comma separator (or end of string)
      if (i < len && line[i] === ",") i++;
    } else {
      // Unquoted field — read until next comma or end
      const start = i;
      while (i < len && line[i] !== ",") i++;
      fields.push(line.slice(start, i));
      if (i < len) i++; // skip comma
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Fallback pricing data (approximate us-east-1 on-demand prices, 2024)
// Used when the live AWS Bulk Pricing API is unreachable.
// ---------------------------------------------------------------------------

const EC2_BASE_PRICES: Record<string, number> = {
  "t2.micro": 0.0116,
  "t2.small": 0.023,
  "t2.medium": 0.0464,
  "t2.large": 0.0928,
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "t3.2xlarge": 0.3328,
  "t3a.micro": 0.0094,
  "t3a.small": 0.0188,
  "t3a.medium": 0.0376,
  "t3a.large": 0.0752,
  "t3a.xlarge": 0.1504,
  "t4g.micro": 0.0084,
  "t4g.small": 0.0168,
  "t4g.medium": 0.0336,
  "t4g.large": 0.0672,
  "t4g.xlarge": 0.1344,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m5.2xlarge": 0.384,
  "m5.4xlarge": 0.768,
  "m5a.large": 0.086,
  "m5a.xlarge": 0.172,
  "m5a.2xlarge": 0.344,
  "m5a.4xlarge": 0.688,
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "m6i.2xlarge": 0.384,
  "m6i.4xlarge": 0.768,
  "m6i.8xlarge": 1.536,
  "m6g.large": 0.077,
  "m6g.xlarge": 0.154,
  "m6g.2xlarge": 0.308,
  "m6g.4xlarge": 0.616,
  "m7i.large": 0.1008,
  "m7i.xlarge": 0.2016,
  "m7i.2xlarge": 0.4032,
  "m7g.large": 0.0816,
  "m7g.xlarge": 0.1632,
  "m7g.2xlarge": 0.3264,
  "m7g.4xlarge": 0.6528,
  "c5.large": 0.085,
  "c5.xlarge": 0.170,
  "c5.2xlarge": 0.340,
  "c5a.large": 0.077,
  "c5a.xlarge": 0.154,
  "c5a.2xlarge": 0.308,
  "c6i.large": 0.085,
  "c6i.xlarge": 0.170,
  "c6i.2xlarge": 0.340,
  "c6g.large": 0.068,
  "c6g.xlarge": 0.136,
  "c6g.2xlarge": 0.272,
  "c6g.4xlarge": 0.544,
  "c7i.large": 0.089,
  "c7i.xlarge": 0.178,
  "c7i.2xlarge": 0.357,
  "c7g.large": 0.072,
  "c7g.xlarge": 0.145,
  "c7g.2xlarge": 0.290,
  "c7g.4xlarge": 0.580,
  "r5.large": 0.126,
  "r5.xlarge": 0.252,
  "r5.2xlarge": 0.504,
  "r5a.large": 0.113,
  "r5a.xlarge": 0.226,
  "r5a.2xlarge": 0.452,
  "r6i.large": 0.126,
  "r6i.xlarge": 0.252,
  "r6i.2xlarge": 0.504,
  "r6g.large": 0.101,
  "r6g.xlarge": 0.202,
  "r6g.2xlarge": 0.403,
  "r6g.4xlarge": 0.806,
  "r7i.large": 0.133,
  "r7i.xlarge": 0.266,
  "r7i.2xlarge": 0.532,
  "r7g.large": 0.107,
  "r7g.xlarge": 0.214,
  "r7g.2xlarge": 0.428,
  "r7g.4xlarge": 0.856,
};

const RDS_BASE_PRICES: Record<string, number> = {
  "db.t3.micro": 0.017,
  "db.t3.small": 0.034,
  "db.t3.medium": 0.068,
  "db.t3.large": 0.136,
  "db.t4g.micro": 0.016,
  "db.t4g.small": 0.032,
  "db.t4g.medium": 0.065,
  "db.t4g.large": 0.129,
  "db.t4g.xlarge": 0.258,
  "db.m5.large": 0.171,
  "db.m5.xlarge": 0.342,
  "db.m6g.large": 0.154,
  "db.m6g.xlarge": 0.308,
  "db.m6g.2xlarge": 0.616,
  "db.m6i.large": 0.171,
  "db.m6i.xlarge": 0.342,
  "db.m6i.2xlarge": 0.684,
  "db.m7g.large": 0.168,
  "db.m7g.xlarge": 0.336,
  "db.m7g.2xlarge": 0.672,
  "db.r5.large": 0.250,
  "db.r5.xlarge": 0.500,
  "db.r5.2xlarge": 1.000,
  "db.r6g.large": 0.218,
  "db.r6g.xlarge": 0.437,
  "db.r6g.2xlarge": 0.874,
  "db.r6i.large": 0.250,
  "db.r6i.xlarge": 0.500,
  "db.r6i.2xlarge": 1.000,
};

const EBS_BASE_PRICES: Record<string, number> = {
  "gp3": 0.08,
  "gp2": 0.10,
  "io2": 0.125,
  "io1": 0.125,
  "st1": 0.045,
  "sc1": 0.015,
};

// ALB pricing per hour (fixed component)
const ALB_HOURLY = 0.0225;
const ALB_LCU_HOURLY = 0.008;

// NAT Gateway pricing
const NAT_HOURLY = 0.045;
const NAT_PER_GB = 0.045;

// EKS control plane
const EKS_HOURLY = 0.10;

// ---------------------------------------------------------------------------
// Regional price multipliers relative to us-east-1.
// Keys are normalised to lower-case AWS region identifiers.
// ---------------------------------------------------------------------------

const REGION_MULTIPLIERS: Record<string, number> = {
  "us-east-1": 1.0,
  "us-east-2": 1.0,
  "us-west-1": 1.08,
  "us-west-2": 1.0,
  "eu-west-1": 1.10,
  "eu-west-2": 1.12,
  "eu-central-1": 1.12,
  "ap-southeast-1": 1.15,
  "ap-southeast-2": 1.15,
  "ap-northeast-1": 1.12,
  "ap-northeast-2": 1.10,
  "ap-south-1": 1.08,
  "sa-east-1": 1.20,
  "ca-central-1": 1.08,
  "eu-north-1": 1.10,
  "eu-south-1": 1.12,
  "me-south-1": 1.15,
  "af-south-1": 1.22,
};

function regionMultiplier(region: string): number {
  return REGION_MULTIPLIERS[region.toLowerCase()] ?? 1.0;
}

const CACHE_TTL = 86400; // 24 hours in seconds

// AWS Bulk Pricing API base URL.
// Service codes used: AmazonEC2, AmazonRDS, AmazonEBS
const BULK_PRICING_BASE =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

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
    os: string = "Linux"
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
    engine: string = "MySQL"
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

  async getStoragePrice(
    volumeType: string,
    region: string
  ): Promise<NormalizedPrice | null> {
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
      const res = await fetch(url, { signal: controller.signal });
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
      const reader = res.body
        .pipeThrough(new TextDecoderStream())
        .getReader();

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
              if (
                colInstanceType === -1 ||
                colOS === -1 ||
                colPrice === -1
              ) {
                logger.debug("AWS EC2 CSV header missing required columns", {
                  region,
                  colInstanceType,
                  colOS,
                  colPrice,
                });
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
        if (
          line.includes("OnDemand") &&
          line.includes("Compute Instance")
        ) {
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
              CACHE_TTL
            );
            cachedCount++;
          }
        }
      }

      logger.debug("AWS EC2 CSV streaming complete", { region, cachedCount });
      return cachedCount > 0;
    } catch (err) {
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
    region: string
  ): Promise<any> {
    const url = `${BULK_PRICING_BASE}/${service}/current/${region}/index.json`;
    logger.debug("Fetching AWS bulk pricing", { url });

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    return res.json();
  }

  private buildCacheKey(
    service: string,
    region: string,
    ...parts: string[]
  ): string {
    return ["aws", service, region, ...parts]
      .map((p) => p.toLowerCase())
      .join("/");
  }

  // -------------------------------------------------------------------------
  // Internal helpers – extract prices from bulk JSON
  // -------------------------------------------------------------------------

  private extractEc2Price(
    bulk: any,
    instanceType: string,
    region: string,
    os: string
  ): NormalizedPrice | null {
    const products: Record<string, any> = bulk?.products ?? {};
    const onDemand: Record<string, any> = bulk?.terms?.OnDemand ?? {};

    for (const [sku, product] of Object.entries(products)) {
      const attrs = product?.attributes ?? {};
      if (
        attrs.instanceType === instanceType &&
        (attrs.operatingSystem ?? "").toLowerCase() === os.toLowerCase() &&
        attrs.tenancy === "Shared" &&
        attrs.capacitystatus === "Used"
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsCompute(product, { terms: { OnDemand: { [sku]: priceTerms } } }, region);
        }
      }
    }
    return null;
  }

  private extractRdsPrice(
    bulk: any,
    instanceClass: string,
    region: string,
    engine: string
  ): NormalizedPrice | null {
    const products: Record<string, any> = bulk?.products ?? {};
    const onDemand: Record<string, any> = bulk?.terms?.OnDemand ?? {};

    for (const [sku, product] of Object.entries(products)) {
      const attrs = product?.attributes ?? {};
      if (
        attrs.instanceType === instanceClass &&
        (attrs.databaseEngine ?? "").toLowerCase().includes(engine.toLowerCase()) &&
        attrs.deploymentOption === "Single-AZ"
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsDatabase(product, { terms: { OnDemand: { [sku]: priceTerms } } }, region);
        }
      }
    }
    return null;
  }

  private extractEbsPrice(
    bulk: any,
    volumeType: string,
    region: string
  ): NormalizedPrice | null {
    const products: Record<string, any> = bulk?.products ?? {};
    const onDemand: Record<string, any> = bulk?.terms?.OnDemand ?? {};

    for (const [sku, product] of Object.entries(products)) {
      const attrs = product?.attributes ?? {};
      const apiName = (attrs.volumeApiName ?? "").toLowerCase();
      if (
        product?.productFamily === "Storage" &&
        (apiName === volumeType.toLowerCase() ||
          (attrs.volumeType ?? "").toLowerCase() === volumeType.toLowerCase())
      ) {
        const priceTerms = onDemand[sku];
        if (priceTerms) {
          return normalizeAwsStorage(product, { terms: { OnDemand: { [sku]: priceTerms } } }, region);
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers – size interpolation
  // -------------------------------------------------------------------------

  /**
   * AWS instance sizes follow a predictable doubling pattern:
   * nano → micro → small → medium → large → xlarge → 2xlarge → 4xlarge → 8xlarge → ...
   * Each step roughly doubles the price. Given a known price at one size,
   * we can estimate the price for a missing size in the same family.
   */
  private static readonly SIZE_ORDER: string[] = [
    "nano", "micro", "small", "medium", "large",
    "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge",
    "16xlarge", "24xlarge", "32xlarge", "48xlarge",
  ];

  private interpolatePrice(
    requestedType: string,
    table: Record<string, number>
  ): number | undefined {
    const lower = requestedType.toLowerCase();
    // Split "m5.2xlarge" → family "m5", size "2xlarge"
    // Split "db.r6g.xlarge" → family "db.r6g", size "xlarge"
    const lastDot = lower.lastIndexOf(".");
    if (lastDot === -1) return undefined;

    const family = lower.slice(0, lastDot);
    const targetSize = lower.slice(lastDot + 1);

    const targetIdx = AwsBulkLoader.SIZE_ORDER.indexOf(targetSize);
    if (targetIdx === -1) return undefined;

    // Find the closest known size in the same family
    let bestKey: string | undefined;
    let bestIdx = -1;
    let bestDistance = Infinity;

    for (const key of Object.keys(table)) {
      const keyLastDot = key.lastIndexOf(".");
      if (keyLastDot === -1) continue;
      const keyFamily = key.slice(0, keyLastDot);
      const keySize = key.slice(keyLastDot + 1);
      if (keyFamily !== family) continue;

      const keyIdx = AwsBulkLoader.SIZE_ORDER.indexOf(keySize);
      if (keyIdx === -1) continue;

      const distance = Math.abs(keyIdx - targetIdx);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIdx = keyIdx;
        bestKey = key;
      }
    }

    if (bestKey === undefined || bestIdx === -1) return undefined;

    const knownPrice = table[bestKey]!;
    const steps = targetIdx - bestIdx;
    // Each step doubles (positive = bigger, negative = smaller)
    return knownPrice * Math.pow(2, steps);
  }

  // -------------------------------------------------------------------------
  // Internal helpers – fallback hardcoded prices
  // -------------------------------------------------------------------------

  private fallbackComputePrice(
    instanceType: string,
    region: string,
    os: string,
    cacheKey: string
  ): NormalizedPrice | null {
    let basePrice = EC2_BASE_PRICES[instanceType.toLowerCase()];
    if (basePrice === undefined) {
      basePrice = this.interpolatePrice(instanceType, EC2_BASE_PRICES) ?? undefined as any;
    }
    if (basePrice === undefined) {
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
    cacheKey: string
  ): NormalizedPrice | null {
    let basePrice = RDS_BASE_PRICES[instanceClass.toLowerCase()];
    if (basePrice === undefined) {
      basePrice = this.interpolatePrice(instanceClass, RDS_BASE_PRICES) ?? undefined as any;
    }
    if (basePrice === undefined) {
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
    cacheKey: string
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
