/**
 * Upstream pricing sources, declared once.
 *
 * The GCP URL previously existed only as a string literal inside
 * scripts/refresh-pricing.ts. Nothing in the test suite referenced it, so when
 * Google deleted the endpoint the only thing that noticed was a weekly workflow
 * whose failure nobody was watching — for four months. Declaring it here lets
 * the integration smoke test probe the exact URL the refresh depends on, so a
 * dead upstream fails a test instead of silently freezing the bundled data.
 */

/** Official Cloud Billing Catalog API; the refresh job supplies a restricted key. */
export const GCP_PRICING_SOURCE_URL = "https://cloudbilling.googleapis.com/v1/services";

/** AWS Bulk Pricing API — genuinely anonymous. */
export const AWS_PRICING_SOURCE_URL = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

/** Azure Retail Prices API — genuinely anonymous. */
export const AZURE_PRICING_SOURCE_URL = "https://prices.azure.com/api/retail/prices";
