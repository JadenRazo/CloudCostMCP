/**
 * A single price dimension from the AWS Bulk Pricing API.
 */
export interface AwsPriceDimension {
  rateCode: string;
  description: string;
  beginRange: string;
  endRange: string;
  unit: string;
  pricePerUnit: {
    USD: string;
    [currency: string]: string;
  };
  appliesTo: string[];
}

/**
 * An offer term (e.g., OnDemand entry) for a single SKU.
 */
export interface AwsOfferTerm {
  offerTermCode: string;
  sku: string;
  effectiveDate: string;
  priceDimensions: Record<string, AwsPriceDimension>;
  termAttributes: Record<string, string>;
}

/**
 * Product attributes from the AWS Bulk Pricing API.
 */
export interface AwsProductAttributes {
  instanceType?: string;
  operatingSystem?: string;
  tenancy?: string;
  capacitystatus?: string;
  vcpu?: string;
  memory?: string;
  databaseEngine?: string;
  deploymentOption?: string;
  volumeApiName?: string;
  volumeType?: string;
  maxIopsvolume?: string;
  maxThroughputvolume?: string;
  [key: string]: string | undefined;
}

/**
 * A product entry from the AWS Bulk Pricing API.
 */
export interface AwsProduct {
  sku: string;
  productFamily: string;
  attributes: AwsProductAttributes;
}

/**
 * Top-level structure of an AWS Bulk Pricing JSON response.
 */
export interface AwsBulkPricingResponse {
  formatVersion: string;
  disclaimer: string;
  offerCode: string;
  version: string;
  publicationDate: string;
  products: Record<string, AwsProduct>;
  terms: {
    OnDemand: Record<string, Record<string, AwsOfferTerm>>;
    Reserved?: Record<string, Record<string, AwsOfferTerm>>;
  };
}

/**
 * Price wrapper passed to normalizer functions.
 * Wraps terms for a single SKU in the expected shape.
 */
export interface AwsPriceWrapper {
  terms: {
    OnDemand: Record<string, Record<string, AwsOfferTerm>>;
  };
}
