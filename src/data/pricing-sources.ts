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

/**
 * gcosts (Cyclenerd/google-cloud-pricing-cost-calculator, Apache-2.0) — a
 * weekly regeneration of the Google Cloud Billing Catalog into a single YAML
 * document. Google retired every key-free bulk pricing source it used to
 * publish, and cloudbilling.googleapis.com rejects unregistered callers, so
 * this is the only source that keeps GCP data refreshable without shipping
 * credentials.
 */
export const GCP_PRICING_SOURCE_URL =
  "https://raw.githubusercontent.com/Cyclenerd/google-cloud-pricing-cost-calculator/master/pricing.yml";

/** AWS Bulk Pricing API — genuinely anonymous. */
export const AWS_PRICING_SOURCE_URL = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

/** Azure Retail Prices API — genuinely anonymous. */
export const AZURE_PRICING_SOURCE_URL = "https://prices.azure.com/api/retail/prices";
