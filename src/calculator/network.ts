import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";

// Assumed data processing volume (GB/month) for NAT gateway cost estimates
// when no explicit traffic figure is available in the resource attributes.
const DEFAULT_NAT_DATA_GB = 100;

/**
 * Calculates the monthly cost for a NAT gateway resource.
 *
 * Cost = hourly_price * monthly_hours + per_gb_price * data_gb
 *
 * The data processing component uses an estimate when the Terraform resource
 * does not specify a traffic volume.
 */
export async function calculateNatGatewayCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
  monthlyHours: number = 730,
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const natPrice = await pricingEngine.getProvider(targetProvider).getNatGatewayPrice(targetRegion);

  let totalMonthly = 0;
  let natPricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (natPrice) {
    const rawSource = natPrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      natPricingSource = "bundled";
    } else if (rawSource === "fallback") {
      natPricingSource = "fallback";
    } else {
      natPricingSource = "live";
    }

    const hourlyCharge = natPrice.price_per_unit * monthlyHours;
    breakdown.push({
      description: `NAT Gateway hourly charge (${monthlyHours}h/month)`,
      unit: "Hrs",
      quantity: monthlyHours,
      unit_price: natPrice.price_per_unit,
      monthly_cost: hourlyCharge,
    });
    totalMonthly += hourlyCharge;

    // Data processing component.
    const perGbPrice = parseFloat(natPrice.attributes?.per_gb_price ?? "0");
    if (perGbPrice > 0) {
      const dataGb =
        (resource.attributes.data_processed_gb as number | undefined) ?? DEFAULT_NAT_DATA_GB;

      if (
        !resource.attributes.data_processed_gb ||
        (resource.attributes.data_processed_gb as number) <= 0
      ) {
        notes.push(
          `Data processing cost estimated at ${dataGb} GB/month; provide data_processed_gb attribute for accuracy`,
        );
      }

      const dataCharge = perGbPrice * dataGb;
      breakdown.push({
        description: `NAT Gateway data processing (${dataGb} GB/month)`,
        unit: "GB",
        quantity: dataGb,
        unit_price: perGbPrice,
        monthly_cost: dataCharge,
      });
      totalMonthly += dataCharge;
    }
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
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
    confidence: natPrice ? "medium" : "low",
    notes,
    pricing_source: natPricingSource,
  };
}

/**
 * Calculates the monthly cost for a load balancer resource.
 *
 * Cost = hourly_price * monthly_hours (fixed component only; LCU/RCU-based
 * traffic charges are excluded as they require runtime traffic data).
 */
export async function calculateLoadBalancerCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
  monthlyHours: number = 730,
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const lbType = (resource.attributes.load_balancer_type as string | undefined) ?? "application";

  const lbPrice = await pricingEngine
    .getProvider(targetProvider)
    .getLoadBalancerPrice(lbType, targetRegion);

  let totalMonthly = 0;
  let lbPricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (lbPrice) {
    const rawSource = lbPrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      lbPricingSource = "bundled";
    } else if (rawSource === "fallback") {
      lbPricingSource = "fallback";
    } else {
      lbPricingSource = "live";
    }

    totalMonthly = lbPrice.price_per_unit * monthlyHours;
    breakdown.push({
      description: `Load Balancer hourly charge (${monthlyHours}h/month)`,
      unit: "Hrs",
      quantity: monthlyHours,
      unit_price: lbPrice.price_per_unit,
      monthly_cost: totalMonthly,
    });
    notes.push(
      "Traffic-based charges (LCU/data processing) are excluded; this is the fixed hourly component only",
    );
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
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
    confidence: lbPrice ? "medium" : "low",
    notes,
    pricing_source: lbPricingSource,
  };
}
