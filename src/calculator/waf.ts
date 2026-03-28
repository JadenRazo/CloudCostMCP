import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default usage assumptions
// ---------------------------------------------------------------------------

const DEFAULT_WAF_RULES = 10;
const DEFAULT_REQUESTS_PER_MONTH = 10_000_000;

// ---------------------------------------------------------------------------
// AWS WAFv2 pricing (2024)
// ---------------------------------------------------------------------------

// $5.00/month per web ACL
const AWS_WAF_WEB_ACL_MONTHLY = 5.0;

// $1.00/month per rule
const AWS_WAF_RULE_MONTHLY = 1.0;

// $0.60 per million requests
const AWS_WAF_PER_MILLION_REQUESTS = 0.6;

// ---------------------------------------------------------------------------
// Azure Web Application Firewall pricing (2024)
// ---------------------------------------------------------------------------

// WAF v2 fixed gateway cost: $0.443/hr = ~$323.39/month (730h)
const AZURE_WAF_GATEWAY_MONTHLY = 323.39;

// Per rule set (custom rules): ~$1/month per rule
const AZURE_WAF_RULE_MONTHLY = 1.0;

// $0.65 per million requests (capacity units)
const AZURE_WAF_PER_MILLION_REQUESTS = 0.65;

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for a WAF resource.
 *
 * AWS WAFv2: $5/month per web ACL + $1/month per rule + $0.60/million requests
 * Azure WAF: ~$323/month gateway + $1/month per rule + $0.65/million requests
 */
export function calculateWafCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const ruleCount = (resource.attributes.rule_count as number | undefined) ?? DEFAULT_WAF_RULES;
  const requestsPerMonth =
    (resource.attributes.monthly_requests as number | undefined) ?? DEFAULT_REQUESTS_PER_MONTH;

  const hasExplicitRules = resource.attributes.rule_count !== undefined;
  const hasExplicitRequests = resource.attributes.monthly_requests !== undefined;

  if (!hasExplicitRules) {
    notes.push(`No rule_count specified; assuming ${DEFAULT_WAF_RULES} rules`);
  }
  if (!hasExplicitRequests) {
    notes.push(
      `No monthly_requests specified; assuming ${DEFAULT_REQUESTS_PER_MONTH.toLocaleString()} requests/month`,
    );
  }

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    // Web ACL fee
    breakdown.push({
      description: "WAFv2 web ACL",
      unit: "ACL/Mo",
      quantity: 1,
      unit_price: AWS_WAF_WEB_ACL_MONTHLY,
      monthly_cost: AWS_WAF_WEB_ACL_MONTHLY,
    });
    totalMonthly += AWS_WAF_WEB_ACL_MONTHLY;

    // Rule fees
    const ruleCost = ruleCount * AWS_WAF_RULE_MONTHLY;
    breakdown.push({
      description: `WAFv2 rules (${ruleCount} rules)`,
      unit: "rule/Mo",
      quantity: ruleCount,
      unit_price: AWS_WAF_RULE_MONTHLY,
      monthly_cost: ruleCost,
    });
    totalMonthly += ruleCost;

    // Request fees
    const requestCost = (requestsPerMonth / 1_000_000) * AWS_WAF_PER_MILLION_REQUESTS;
    breakdown.push({
      description: `WAFv2 request inspection (${(requestsPerMonth / 1_000_000).toFixed(1)}M requests/month)`,
      unit: "1M requests",
      quantity: requestsPerMonth / 1_000_000,
      unit_price: AWS_WAF_PER_MILLION_REQUESTS,
      monthly_cost: requestCost,
    });
    totalMonthly += requestCost;

    const scope = (resource.attributes.scope as string | undefined) ?? "REGIONAL";
    notes.push(`AWS WAFv2 scope: ${scope}`);
  } else if (targetProvider === "azure") {
    // Gateway fixed cost
    breakdown.push({
      description: "WAF gateway (Application Gateway WAF v2)",
      unit: "Mo",
      quantity: 1,
      unit_price: AZURE_WAF_GATEWAY_MONTHLY,
      monthly_cost: AZURE_WAF_GATEWAY_MONTHLY,
    });
    totalMonthly += AZURE_WAF_GATEWAY_MONTHLY;

    // Rule fees
    const ruleCost = ruleCount * AZURE_WAF_RULE_MONTHLY;
    breakdown.push({
      description: `WAF custom rules (${ruleCount} rules)`,
      unit: "rule/Mo",
      quantity: ruleCount,
      unit_price: AZURE_WAF_RULE_MONTHLY,
      monthly_cost: ruleCost,
    });
    totalMonthly += ruleCost;

    // Request fees
    const requestCost = (requestsPerMonth / 1_000_000) * AZURE_WAF_PER_MILLION_REQUESTS;
    breakdown.push({
      description: `WAF request processing (${(requestsPerMonth / 1_000_000).toFixed(1)}M requests/month)`,
      unit: "1M requests",
      quantity: requestsPerMonth / 1_000_000,
      unit_price: AZURE_WAF_PER_MILLION_REQUESTS,
      monthly_cost: requestCost,
    });
    totalMonthly += requestCost;
  } else {
    // GCP does not have a direct WAF equivalent in the same pricing model.
    // Google Cloud Armor is the closest service.
    // $5/month per policy + $1/month per rule + $0.75/million requests
    const policyFee = 5.0;
    breakdown.push({
      description: "Cloud Armor security policy",
      unit: "policy/Mo",
      quantity: 1,
      unit_price: policyFee,
      monthly_cost: policyFee,
    });
    totalMonthly += policyFee;

    const ruleCost = ruleCount * 1.0;
    breakdown.push({
      description: `Cloud Armor rules (${ruleCount} rules)`,
      unit: "rule/Mo",
      quantity: ruleCount,
      unit_price: 1.0,
      monthly_cost: ruleCost,
    });
    totalMonthly += ruleCost;

    const requestCost = (requestsPerMonth / 1_000_000) * 0.75;
    breakdown.push({
      description: `Cloud Armor request evaluation (${(requestsPerMonth / 1_000_000).toFixed(1)}M requests/month)`,
      unit: "1M requests",
      quantity: requestsPerMonth / 1_000_000,
      unit_price: 0.75,
      monthly_cost: requestCost,
    });
    totalMonthly += requestCost;

    notes.push("GCP equivalent: Cloud Armor security policy");
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
    confidence: hasExplicitRules && hasExplicitRequests ? "high" : "medium",
    notes,
    pricing_source: "fallback",
  };
}
