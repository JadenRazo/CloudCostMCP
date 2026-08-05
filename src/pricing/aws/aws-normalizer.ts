import type { NormalizedPrice } from "../../types/pricing.js";
import type { AwsProduct, AwsPriceWrapper, AwsPriceDimension, AwsOfferTerm } from "./types.js";
import { resolveEffectiveDate } from "../effective-date.js";

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

interface AwsNormalizeSpec {
  service: string;
  defaultUnit: string;
  resourceType: string;
  description?: string;
  attributes: Record<string, string>;
}

/**
 * Shared body of the AWS normalizers: extracts price + unit from the OnDemand
 * terms and assembles the canonical NormalizedPrice literal.
 */
function normalize(
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate: string | undefined,
  spec: AwsNormalizeSpec,
): NormalizedPrice {
  const terms = rawPrice?.terms?.OnDemand ?? {};
  const { price, unit } = extractFromTerms(terms, spec.defaultUnit);

  return {
    provider: "aws",
    service: spec.service,
    resource_type: spec.resourceType,
    region,
    unit,
    price_per_unit: price,
    currency: "USD",
    description: spec.description,
    attributes: {
      ...spec.attributes,
      pricing_source: "live",
    },
    effective_date: resolveEffectiveDate(effectiveDate),
  };
}

export function normalizeAwsCompute(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  return normalize(rawPrice, region, effectiveDate, {
    service: "ec2",
    defaultUnit: "Hrs",
    resourceType: attrs.instanceType ?? "unknown",
    description: attrs.instanceType
      ? `AWS EC2 ${attrs.instanceType} (${attrs.operatingSystem ?? "Linux"})`
      : undefined,
    attributes: {
      instance_type: attrs.instanceType ?? "",
      vcpu: attrs.vcpu ?? "",
      memory: attrs.memory ?? "",
      operating_system: attrs.operatingSystem ?? "Linux",
      tenancy: attrs.tenancy ?? "Shared",
    },
  });
}

export function normalizeAwsDatabase(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  return normalize(rawPrice, region, effectiveDate, {
    service: "rds",
    defaultUnit: "Hrs",
    resourceType: attrs.instanceType ?? "unknown",
    description: attrs.instanceType
      ? `AWS RDS ${attrs.instanceType} (${attrs.databaseEngine ?? "MySQL"})`
      : undefined,
    attributes: {
      instance_type: attrs.instanceType ?? "",
      database_engine: attrs.databaseEngine ?? "",
      deployment_option: attrs.deploymentOption ?? "Single-AZ",
      vcpu: attrs.vcpu ?? "",
      memory: attrs.memory ?? "",
    },
  });
}

export function normalizeAwsStorage(
  rawProduct: AwsProduct,
  rawPrice: AwsPriceWrapper,
  region: string,
  effectiveDate?: string,
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const volumeType = attrs.volumeApiName ?? attrs.volumeType ?? "gp3";
  return normalize(rawPrice, region, effectiveDate, {
    service: "ebs",
    defaultUnit: "GB-Mo",
    resourceType: volumeType,
    description: `AWS EBS ${volumeType} volume`,
    attributes: {
      volume_type: volumeType,
      max_iops: attrs.maxIopsvolume ?? "",
      max_throughput: attrs.maxThroughputvolume ?? "",
    },
  });
}
