import type { NormalizedPrice } from "../../types/pricing.js";

/**
 * Convert a single item from the Azure Retail Prices API response into a
 * NormalizedPrice.  The raw item shape is documented at:
 * https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 */

export function normalizeAzureCompute(item: any): NormalizedPrice {
  return {
    provider: "azure",
    service: "virtual-machines",
    resource_type: item.skuName ?? item.armSkuName ?? "unknown",
    region: item.armRegionName ?? item.location ?? "",
    unit: item.unitOfMeasure ?? "1 Hour",
    price_per_unit: item.retailPrice ?? item.unitPrice ?? 0,
    currency: item.currencyCode ?? "USD",
    tier: item.tierMinimumUnits !== undefined ? String(item.tierMinimumUnits) : undefined,
    description: item.productName ?? undefined,
    attributes: {
      sku_name: item.skuName ?? "",
      arm_sku_name: item.armSkuName ?? "",
      service_name: item.serviceName ?? "Virtual Machines",
      product_name: item.productName ?? "",
      meter_name: item.meterName ?? "",
      pricing_source: "live",
    },
    effective_date: item.effectiveStartDate ?? new Date().toISOString(),
  };
}

export function normalizeAzureDatabase(item: any): NormalizedPrice {
  return {
    provider: "azure",
    service: "azure-database",
    resource_type: item.skuName ?? item.armSkuName ?? "unknown",
    region: item.armRegionName ?? item.location ?? "",
    unit: item.unitOfMeasure ?? "1 Hour",
    price_per_unit: item.retailPrice ?? item.unitPrice ?? 0,
    currency: item.currencyCode ?? "USD",
    description: item.productName ?? undefined,
    attributes: {
      sku_name: item.skuName ?? "",
      service_name: item.serviceName ?? "",
      product_name: item.productName ?? "",
      meter_name: item.meterName ?? "",
      pricing_source: "live",
    },
    effective_date: item.effectiveStartDate ?? new Date().toISOString(),
  };
}

export function normalizeAzureStorage(item: any): NormalizedPrice {
  return {
    provider: "azure",
    service: "managed-disks",
    resource_type: item.skuName ?? item.armSkuName ?? "unknown",
    region: item.armRegionName ?? item.location ?? "",
    unit: item.unitOfMeasure ?? "1 GiB/Month",
    price_per_unit: item.retailPrice ?? item.unitPrice ?? 0,
    currency: item.currencyCode ?? "USD",
    description: item.productName ?? undefined,
    attributes: {
      sku_name: item.skuName ?? "",
      service_name: item.serviceName ?? "",
      product_name: item.productName ?? "",
      meter_name: item.meterName ?? "",
      pricing_source: "live",
    },
    effective_date: item.effectiveStartDate ?? new Date().toISOString(),
  };
}
