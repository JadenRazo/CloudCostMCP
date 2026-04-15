import type { NormalizedPrice } from "../../types/pricing.js";
import type { AwsProduct, AwsPriceWrapper, AwsPriceDimension, AwsOfferTerm } from "./types.js";

/**
 * Convert a raw AWS bulk pricing product + price term into a NormalizedPrice.
 *
 * AWS bulk JSON has the shape:
 *   products[sku].attributes  – metadata about the SKU
 *   terms.OnDemand[sku][offerTermCode].priceDimensions[rateCode]  – price info
 *
 * The callers wrap the terms as { terms: { OnDemand: { [sku]: termsForSku } } }
 * so Object.values(OnDemand) yields [ termsForSku ], and each termsForSku is
 * itself a map of offerTermCode → { priceDimensions }.  We must iterate both
 * levels to reach the actual priceDimensions.
 */

function extractUsdPrice(priceDimensions: Record<string, AwsPriceDimension>): number {
  for (const dim of Object.values(priceDimensions)) {
    const usd = dim?.pricePerUnit?.USD;
    if (usd !== undefined) {
      const val = parseFloat(usd);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
}

function extractUnit(priceDimensions: Record<string, AwsPriceDimension>): string {
  for (const dim of Object.values(priceDimensions)) {
    if (dim?.unit) return String(dim.unit);
  }
  return "Hrs";
}

/**
 * Walk the nested OnDemand terms structure and extract the first price + unit.
 *
 * Structure: { [sku]: { [offerTermCode]: { priceDimensions: { [rateCode]: ... } } } }
 */
function extractFromTerms(
  onDemandTerms: Record<string, Record<string, AwsOfferTerm>>,
  defaultUnit: string,
): { price: number; unit: string } {
  for (const skuTerms of Object.values(onDemandTerms)) {
    // skuTerms = { "SKU.TERMCODE": { priceDimensions: { ... } } }
    // If priceDimensions exists directly (single-level), use it.
    const asOfferTerm = skuTerms as unknown as AwsOfferTerm;
    if (asOfferTerm?.priceDimensions) {
      return {
        price: extractUsdPrice(asOfferTerm.priceDimensions),
        unit: extractUnit(asOfferTerm.priceDimensions),
      };
    }
    // Otherwise iterate the nested offerTermCode level.
    for (const offerTerm of Object.values(skuTerms ?? {})) {
      if (offerTerm?.priceDimensions) {
        return {
          price: extractUsdPrice(offerTerm.priceDimensions),
          unit: extractUnit(offerTerm.priceDimensions),
        };
      }
    }
  }
  return { price: 0, unit: defaultUnit };
}

/**
 * Normalize an upstream `effectiveDate` (typically the AWS bulk JSON's
 * top-level `publicationDate`) into an ISO string. Falls back to "now" when
 * the value is absent or unparseable so downstream consumers always see a
 * valid ISO date.
 */
function resolveEffectiveDate(effectiveDate?: string): string {
  if (effectiveDate) {
    const t = new Date(effectiveDate);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return new Date().toISOString();
}

export function normalizeAwsCompute(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  const { price, unit } = extractFromTerms(terms, "Hrs");

  return {
    provider: "aws",
    service: "ec2",
    resource_type: attrs.instanceType ?? "unknown",
    region,
    unit,
    price_per_unit: price,
    currency: "USD",
    description: attrs.instanceType
      ? `AWS EC2 ${attrs.instanceType} (${attrs.operatingSystem ?? "Linux"})`
      : undefined,
    attributes: {
      instance_type: attrs.instanceType ?? "",
      vcpu: attrs.vcpu ?? "",
      memory: attrs.memory ?? "",
      operating_system: attrs.operatingSystem ?? "Linux",
      tenancy: attrs.tenancy ?? "Shared",
      pricing_source: "live",
    },
    effective_date: resolveEffectiveDate(effectiveDate),
  };
}

export function normalizeAwsDatabase(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  const { price, unit } = extractFromTerms(terms, "Hrs");

  return {
    provider: "aws",
    service: "rds",
    resource_type: attrs.instanceType ?? "unknown",
    region,
    unit,
    price_per_unit: price,
    currency: "USD",
    description: attrs.instanceType
      ? `AWS RDS ${attrs.instanceType} (${attrs.databaseEngine ?? "MySQL"})`
      : undefined,
    attributes: {
      instance_type: attrs.instanceType ?? "",
      database_engine: attrs.databaseEngine ?? "",
      deployment_option: attrs.deploymentOption ?? "Single-AZ",
      vcpu: attrs.vcpu ?? "",
      memory: attrs.memory ?? "",
      pricing_source: "live",
    },
    effective_date: resolveEffectiveDate(effectiveDate),
  };
}

export function normalizeAwsStorage(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  const { price, unit } = extractFromTerms(terms, "GB-Mo");

  const volumeType = attrs.volumeApiName ?? attrs.volumeType ?? "gp3";

  return {
    provider: "aws",
    service: "ebs",
    resource_type: volumeType,
    region,
    unit,
    price_per_unit: price,
    currency: "USD",
    description: `AWS EBS ${volumeType} volume`,
    attributes: {
      volume_type: volumeType,
      max_iops: attrs.maxIopsvolume ?? "",
      max_throughput: attrs.maxThroughputvolume ?? "",
      pricing_source: "live",
    },
    effective_date: resolveEffectiveDate(effectiveDate),
  };
}
