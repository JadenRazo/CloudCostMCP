/**
 * A single item from the Azure Retail Prices API response.
 * Documented at: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 */
export interface AzureRetailPriceItem {
  currencyCode: string;
  tierMinimumUnits: number;
  retailPrice: number;
  unitPrice: number;
  armRegionName: string;
  location: string;
  effectiveStartDate: string;
  meterId: string;
  meterName: string;
  productId: string;
  skuId: string;
  productName: string;
  skuName: string;
  serviceName: string;
  serviceId: string;
  serviceFamily: string;
  unitOfMeasure: string;
  type: string;
  isPrimaryMeterRegion: boolean;
  armSkuName: string;
  reservationTerm?: string;
  priceType?: string;
}

/**
 * Paginated response from the Azure Retail Prices API.
 */
export interface AzureRetailPriceResponse {
  BillingCurrency: string;
  CustomerEntityId: string;
  CustomerEntityType: string;
  Items: AzureRetailPriceItem[];
  NextPageLink: string | null;
  Count: number;
}
