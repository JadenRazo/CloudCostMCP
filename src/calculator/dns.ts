import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Static pricing tables (bundled)
// ---------------------------------------------------------------------------

// AWS Route 53: $0.50/hosted zone/month + $0.40 per million queries
const AWS_ROUTE53_PER_ZONE = 0.5;
const AWS_ROUTE53_PER_MILLION_QUERIES = 0.4;

// Azure DNS: $0.50/zone/month + $0.40 per million queries
const AZURE_DNS_PER_ZONE = 0.5;
const AZURE_DNS_PER_MILLION_QUERIES = 0.4;

// GCP Cloud DNS: $0.20/zone/month + $0.40 per million queries
const GCP_CLOUD_DNS_PER_ZONE = 0.2;
const GCP_CLOUD_DNS_PER_MILLION_QUERIES = 0.4;

// Default query volume when not specified in resource attributes
const DEFAULT_QUERIES_PER_MONTH = 1_000_000;

/**
 * Calculates the monthly cost for a DNS zone resource.
 *
 * Cost = zone_fee + (queries_per_month / 1_000_000) * per_million_query_price
 *
 * Each provider has a flat per-zone fee plus a per-million-query charge.
 * GCP Cloud DNS has a lower zone fee than AWS and Azure.
 */
export function calculateDnsCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const queriesPerMonth =
    (resource.attributes.queries_per_month as number | undefined) ?? DEFAULT_QUERIES_PER_MONTH;

  const hasExplicitQueries = resource.attributes.queries_per_month !== undefined;

  if (!hasExplicitQueries) {
    notes.push(
      `No queries_per_month specified; assuming ${DEFAULT_QUERIES_PER_MONTH.toLocaleString()} queries/month`,
    );
  }

  let zonePrice: number;
  let queryPrice: number;
  let serviceLabel: string;

  if (targetProvider === "aws") {
    zonePrice = AWS_ROUTE53_PER_ZONE;
    queryPrice = AWS_ROUTE53_PER_MILLION_QUERIES;
    serviceLabel = "Route 53";
  } else if (targetProvider === "azure") {
    zonePrice = AZURE_DNS_PER_ZONE;
    queryPrice = AZURE_DNS_PER_MILLION_QUERIES;
    serviceLabel = "Azure DNS";
  } else {
    // gcp
    zonePrice = GCP_CLOUD_DNS_PER_ZONE;
    queryPrice = GCP_CLOUD_DNS_PER_MILLION_QUERIES;
    serviceLabel = "Cloud DNS";
  }

  // Flat zone fee
  breakdown.push({
    description: `${serviceLabel} hosted zone`,
    unit: "zone/Mo",
    quantity: 1,
    unit_price: zonePrice,
    monthly_cost: zonePrice,
  });

  // Query charges
  const millionsOfQueries = queriesPerMonth / 1_000_000;
  const queryCost = queryPrice * millionsOfQueries;
  breakdown.push({
    description: `${serviceLabel} DNS queries (${queriesPerMonth.toLocaleString()} queries/month)`,
    unit: "million queries",
    quantity: millionsOfQueries,
    unit_price: queryPrice,
    monthly_cost: queryCost,
  });

  const totalMonthly = zonePrice + queryCost;

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: hasExplicitQueries ? "high" : "medium",
    notes,
    pricing_source: "bundled",
  };
}
