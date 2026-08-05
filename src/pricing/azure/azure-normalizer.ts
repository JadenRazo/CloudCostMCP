import type { NormalizedPrice } from "../../types/pricing.js";
import type { AzureRetailPriceItem } from "./types.js";
import { resolveEffectiveDate } from "../effective-date.js";

/**
 * Convert a single item from the Azure Retail Prices API response into a
 * NormalizedPrice.  The raw item shape is documented at:
 * https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 */

interface AzureNormalizeSpec {
  service: string;
  defaultUnit: string;
  /** Compute rows carry the tier (minimum units) through; others do not. */
  includeTier?: boolean;
  /** Default for the service_name attribute when the item omits serviceName. */
  defaultServiceName?: string;
  /** Extra provider-specific attributes merged into the attribute map. */
  extraAttributes?: (item: AzureRetailPriceItem) => Record<string, string>;
}

/**
 * Shared body of the Azure normalizers: maps the Retail Prices API item onto
 * the canonical NormalizedPrice literal.
 */
function normalize(item: AzureRetailPriceItem, spec: AzureNormalizeSpec): NormalizedPrice {
  return {
    provider: "azure",
    service: spec.service,
    resource_type: item.skuName ?? item.armSkuName ?? "unknown",
    region: item.armRegionName ?? item.location ?? "",
    unit: item.unitOfMeasure ?? spec.defaultUnit,
    price_per_unit: item.retailPrice ?? item.unitPrice ?? 0,
    currency: item.currencyCode ?? "USD",
    tier:
      spec.includeTier && item.tierMinimumUnits !== undefined
        ? String(item.tierMinimumUnits)
        : undefined,
    description: item.productName ?? undefined,
    attributes: {
      sku_name: item.skuName ?? "",
      ...spec.extraAttributes?.(item),
      service_name: item.serviceName ?? spec.defaultServiceName ?? "",
      product_name: item.productName ?? "",
      meter_name: item.meterName ?? "",
      pricing_source: "live",
    },
    effective_date: resolveEffectiveDate(item.effectiveStartDate),
  };
}

export function normalizeAzureCompute(item: AzureRetailPriceItem): NormalizedPrice {
  return normalize(item, {
    service: "virtual-machines",
    defaultUnit: "1 Hour",
    includeTier: true,
    defaultServiceName: "Virtual Machines",
    extraAttributes: (i) => ({ arm_sku_name: i.armSkuName ?? "" }),
  });
}

export function normalizeAzureDatabase(item: AzureRetailPriceItem): NormalizedPrice {
  return normalize(item, {
    service: "azure-database",
    defaultUnit: "1 Hour",
  });
}

export function normalizeAzureStorage(item: AzureRetailPriceItem): NormalizedPrice {
  return normalize(item, {
    service: "managed-disks",
    defaultUnit: "1 GiB/Month",
  });
}
