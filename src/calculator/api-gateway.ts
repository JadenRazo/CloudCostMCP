import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default usage assumptions
// ---------------------------------------------------------------------------

const DEFAULT_REQUESTS_PER_MONTH = 1_000_000;

// ---------------------------------------------------------------------------
// AWS API Gateway pricing (us-east-1 on-demand, 2024)
// ---------------------------------------------------------------------------

// REST API: $3.50/million requests (first 333M)
const AWS_REST_API_PER_MILLION_REQUESTS = 3.5;

// HTTP API: $1.00/million requests (first 300M)
const AWS_HTTP_API_PER_MILLION_REQUESTS = 1.0;

// WebSocket API: $1.00/million connection-minutes + $1.00/million messages
const AWS_WEBSOCKET_PER_MILLION_MESSAGES = 1.0;
const AWS_WEBSOCKET_PER_MILLION_CONNECTION_MINUTES = 1.0;

// ---------------------------------------------------------------------------
// Azure API Management pricing (per-tier monthly)
// ---------------------------------------------------------------------------

const AZURE_APIM_TIER_MONTHLY: Record<string, number> = {
  developer: 48.36,
  basic: 151.84,
  standard: 683.28,
  premium: 2803.46,
  consumption: 0, // pay-per-call only
};

const AZURE_APIM_CONSUMPTION_PER_10K_CALLS = 0.035;
const AZURE_APIM_DEFAULT_TIER = "consumption";

// ---------------------------------------------------------------------------
// GCP API Gateway pricing
// ---------------------------------------------------------------------------

// $3.00 per million calls (first 2M free)
const GCP_API_GATEWAY_PER_MILLION_CALLS = 3.0;
const GCP_API_GATEWAY_FREE_TIER_CALLS = 2_000_000;

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for an API Gateway resource.
 *
 * AWS REST API: $3.50/million requests
 * AWS HTTP API: $1.00/million requests
 * AWS WebSocket: $1.00/million messages + $1.00/million connection-minutes
 * Azure API Management: tier-based fixed monthly cost or consumption pricing
 * GCP API Gateway: $3.00/million calls (first 2M free)
 */
export function calculateApiGatewayCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const requestsPerMonth =
    (resource.attributes.monthly_requests as number | undefined) ?? DEFAULT_REQUESTS_PER_MONTH;

  const hasExplicitRequests = resource.attributes.monthly_requests !== undefined;

  if (!hasExplicitRequests) {
    notes.push(
      `No monthly_requests specified; assuming ${DEFAULT_REQUESTS_PER_MONTH.toLocaleString()} requests/month`,
    );
  }

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    const apiType = ((resource.attributes.api_type as string | undefined) ?? "REST").toUpperCase();

    if (apiType === "WEBSOCKET") {
      // WebSocket API
      const messageCost = (requestsPerMonth / 1_000_000) * AWS_WEBSOCKET_PER_MILLION_MESSAGES;
      const connectionMinCost =
        (requestsPerMonth / 1_000_000) * AWS_WEBSOCKET_PER_MILLION_CONNECTION_MINUTES;

      breakdown.push({
        description: `API Gateway WebSocket messages (${(requestsPerMonth / 1_000_000).toFixed(1)}M/month)`,
        unit: "1M messages",
        quantity: requestsPerMonth / 1_000_000,
        unit_price: AWS_WEBSOCKET_PER_MILLION_MESSAGES,
        monthly_cost: messageCost,
      });
      breakdown.push({
        description: `API Gateway WebSocket connection-minutes`,
        unit: "1M conn-min",
        quantity: requestsPerMonth / 1_000_000,
        unit_price: AWS_WEBSOCKET_PER_MILLION_CONNECTION_MINUTES,
        monthly_cost: connectionMinCost,
      });

      totalMonthly = messageCost + connectionMinCost;
      notes.push(
        "WebSocket API pricing: $1.00/million messages + $1.00/million connection-minutes",
      );
    } else if (apiType === "HTTP") {
      // HTTP API (v2)
      const requestCost = (requestsPerMonth / 1_000_000) * AWS_HTTP_API_PER_MILLION_REQUESTS;
      breakdown.push({
        description: `API Gateway HTTP API requests (${(requestsPerMonth / 1_000_000).toFixed(1)}M/month)`,
        unit: "1M requests",
        quantity: requestsPerMonth / 1_000_000,
        unit_price: AWS_HTTP_API_PER_MILLION_REQUESTS,
        monthly_cost: requestCost,
      });
      totalMonthly = requestCost;
    } else {
      // REST API (default)
      const requestCost = (requestsPerMonth / 1_000_000) * AWS_REST_API_PER_MILLION_REQUESTS;
      breakdown.push({
        description: `API Gateway REST API requests (${(requestsPerMonth / 1_000_000).toFixed(1)}M/month)`,
        unit: "1M requests",
        quantity: requestsPerMonth / 1_000_000,
        unit_price: AWS_REST_API_PER_MILLION_REQUESTS,
        monthly_cost: requestCost,
      });
      totalMonthly = requestCost;
    }
  } else if (targetProvider === "azure") {
    const tier = (
      (resource.attributes.sku as string | undefined) ?? AZURE_APIM_DEFAULT_TIER
    ).toLowerCase();

    const fixedCost = AZURE_APIM_TIER_MONTHLY[tier] ?? AZURE_APIM_TIER_MONTHLY["consumption"]!;

    if (fixedCost > 0) {
      breakdown.push({
        description: `API Management ${tier} tier`,
        unit: "Mo",
        quantity: 1,
        unit_price: fixedCost,
        monthly_cost: fixedCost,
      });
      totalMonthly = fixedCost;
      notes.push(`Azure API Management ${tier} tier: fixed monthly pricing`);
    } else {
      // Consumption tier
      const callsIn10K = requestsPerMonth / 10_000;
      const callCost = callsIn10K * AZURE_APIM_CONSUMPTION_PER_10K_CALLS;
      breakdown.push({
        description: `API Management consumption (${requestsPerMonth.toLocaleString()} calls/month)`,
        unit: "10K calls",
        quantity: callsIn10K,
        unit_price: AZURE_APIM_CONSUMPTION_PER_10K_CALLS,
        monthly_cost: callCost,
      });
      totalMonthly = callCost;
      notes.push("Azure API Management consumption tier: $0.035 per 10,000 calls");
    }
  } else {
    // gcp
    const billableRequests = Math.max(0, requestsPerMonth - GCP_API_GATEWAY_FREE_TIER_CALLS);
    const requestCost = (billableRequests / 1_000_000) * GCP_API_GATEWAY_PER_MILLION_CALLS;

    breakdown.push({
      description: `API Gateway calls (${requestsPerMonth.toLocaleString()} total, ${billableRequests.toLocaleString()} billable)`,
      unit: "1M calls",
      quantity: billableRequests / 1_000_000,
      unit_price: GCP_API_GATEWAY_PER_MILLION_CALLS,
      monthly_cost: requestCost,
    });
    totalMonthly = requestCost;

    if (requestsPerMonth <= GCP_API_GATEWAY_FREE_TIER_CALLS) {
      notes.push("All requests within GCP API Gateway free tier (2M calls/month)");
    } else {
      notes.push(
        `GCP API Gateway: first ${GCP_API_GATEWAY_FREE_TIER_CALLS.toLocaleString()} calls free, then $${GCP_API_GATEWAY_PER_MILLION_CALLS}/million`,
      );
    }
  }

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
    confidence: hasExplicitRequests ? "high" : "medium",
    notes,
    pricing_source: "fallback",
  };
}
