import type { NormalizedPrice } from "../../types/pricing.js";

/**
 * Convert a raw AWS bulk pricing product + price term into a NormalizedPrice.
 *
 * AWS bulk JSON has the shape:
 *   products[sku].attributes  – metadata about the SKU
 *   terms.OnDemand[sku][offerTermCode].priceDimensions[rateCode]  – price info
 */

function extractUsdPrice(priceDimensions: Record<string, any>): number {
  for (const dim of Object.values(priceDimensions)) {
    const usd = dim?.pricePerUnit?.USD;
    if (usd !== undefined) {
      const val = parseFloat(usd);
      if (!isNaN(val)) return val;
    }
  }
  return 0;
}

function extractUnit(priceDimensions: Record<string, any>): string {
  for (const dim of Object.values(priceDimensions)) {
    if (dim?.unit) return String(dim.unit);
  }
  return "Hrs";
}

export function normalizeAwsCompute(
  rawProduct: any,
  rawPrice: any,
  region: string
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  let price = 0;
  let unit = "Hrs";

  for (const term of Object.values(terms)) {
    const dims = (term as any)?.priceDimensions ?? {};
    price = extractUsdPrice(dims);
    unit = extractUnit(dims);
    break; // take the first on-demand term
  }

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
    },
    effective_date: new Date().toISOString(),
  };
}

export function normalizeAwsDatabase(
  rawProduct: any,
  rawPrice: any,
  region: string
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  let price = 0;
  let unit = "Hrs";

  for (const term of Object.values(terms)) {
    const dims = (term as any)?.priceDimensions ?? {};
    price = extractUsdPrice(dims);
    unit = extractUnit(dims);
    break;
  }

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
    },
    effective_date: new Date().toISOString(),
  };
}

export function normalizeAwsStorage(
  rawProduct: any,
  rawPrice: any,
  region: string
): NormalizedPrice {
  const attrs = rawProduct?.attributes ?? {};
  const terms = rawPrice?.terms?.OnDemand ?? {};
  let price = 0;
  let unit = "GB-Mo";

  for (const term of Object.values(terms)) {
    const dims = (term as any)?.priceDimensions ?? {};
    price = extractUsdPrice(dims);
    unit = extractUnit(dims);
    break;
  }

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
    },
    effective_date: new Date().toISOString(),
  };
}
