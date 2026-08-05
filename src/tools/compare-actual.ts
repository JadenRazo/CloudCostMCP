import { z } from "zod";
import type { CloudProvider } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraformState } from "../parsers/terraform/state-parser.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import {
  convertBreakdownCurrency,
  getExchangeRateInfo,
  type ExchangeRateInfo,
} from "../currency.js";
import { getPricingMetadata, type PricingMetadataBlock } from "../data/loader.js";
import { stateJsonSchema, shortStringSchema } from "../schemas/bounded.js";
import { iacFilesSchema, tfvarsField, providerEnum, currencyField } from "../schemas/fragments.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const compareActualSchema = z.object({
  state_json: stateJsonSchema.describe("Contents of terraform.tfstate file (JSON)"),
  files: iacFilesSchema
    .optional()
    .describe("Optional Terraform files to compare planned costs against actual"),
  tfvars: tfvarsField,
  provider: providerEnum
    .optional()
    .describe("Target cloud provider override. Defaults to auto-detecting from the state."),
  region: shortStringSchema
    .optional()
    .describe(
      "Target region override for pricing. Defaults to the region detected from the state.",
    ),
  currency: currencyField,
});

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CompareActualResult {
  provider: CloudProvider;
  region: string;
  currency: string;
  actual_costs: {
    total_monthly: number;
    total_yearly: number;
    resource_count: number;
    by_resource: Array<{
      resource_id: string;
      resource_type: string;
      monthly_cost: number;
    }>;
  };
  planned_costs?: {
    total_monthly: number;
    total_yearly: number;
    resource_count: number;
    by_resource: Array<{
      resource_id: string;
      resource_type: string;
      monthly_cost: number;
    }>;
  };
  delta?: {
    monthly: number;
    yearly: number;
    pct_change: number;
  };
  warnings: string[];
  /** Freshness of the bundled pricing data that produced these numbers. */
  pricing_metadata?: PricingMetadataBlock;
  /** Present when currency !== USD: the static rate + vintage applied. */
  exchange_rate?: ExchangeRateInfo;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Parse a Terraform state file and calculate actual infrastructure costs.
 * Optionally compares against planned costs from HCL files.
 */
export async function compareActual(
  params: z.infer<typeof compareActualSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig,
): Promise<CompareActualResult> {
  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Parse state → actual inventory
  // -------------------------------------------------------------------------
  const stateInventory = parseTerraformState(params.state_json);
  warnings.push(...stateInventory.parse_warnings);

  const targetProvider: CloudProvider =
    (params.provider as CloudProvider | undefined) ?? stateInventory.provider;

  const targetRegion = params.region ?? stateInventory.region;

  const costEngine = new CostEngine(pricingEngine, config);

  // -------------------------------------------------------------------------
  // Actual costs from state
  // -------------------------------------------------------------------------
  const actualBreakdown = await costEngine.calculateBreakdown(
    stateInventory.resources,
    targetProvider,
    targetRegion,
  );
  warnings.push(...(actualBreakdown.warnings ?? []));

  const actualByResource = actualBreakdown.by_resource.map((r) => ({
    resource_id: r.resource_id,
    resource_type: r.resource_type,
    monthly_cost: Math.round(r.monthly_cost * 100) / 100,
  }));

  const currency = params.currency ?? "USD";

  const result: CompareActualResult = {
    provider: targetProvider,
    region: targetRegion,
    currency,
    actual_costs: {
      total_monthly: Math.round(actualBreakdown.total_monthly * 100) / 100,
      total_yearly: Math.round(actualBreakdown.total_monthly * 12 * 100) / 100,
      resource_count: stateInventory.total_count,
      by_resource: actualByResource,
    },
    warnings: [],
    pricing_metadata: getPricingMetadata(targetProvider),
  };

  // -------------------------------------------------------------------------
  // Planned costs from HCL files (optional)
  // -------------------------------------------------------------------------
  if (params.files && params.files.length > 0) {
    const plannedInventory = await parseTerraform(params.files, params.tfvars);
    warnings.push(...plannedInventory.parse_warnings);

    const plannedProvider: CloudProvider =
      (params.provider as CloudProvider | undefined) ?? plannedInventory.provider;

    const plannedRegion =
      params.region ??
      mapRegion(plannedInventory.region, plannedInventory.provider, plannedProvider);

    const plannedBreakdown = await costEngine.calculateBreakdown(
      plannedInventory.resources,
      plannedProvider,
      plannedRegion,
    );
    warnings.push(...(plannedBreakdown.warnings ?? []));

    const plannedByResource = plannedBreakdown.by_resource.map((r) => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type,
      monthly_cost: Math.round(r.monthly_cost * 100) / 100,
    }));

    result.planned_costs = {
      total_monthly: Math.round(plannedBreakdown.total_monthly * 100) / 100,
      total_yearly: Math.round(plannedBreakdown.total_monthly * 12 * 100) / 100,
      resource_count: plannedInventory.total_count,
      by_resource: plannedByResource,
    };

    // Delta: actual - planned
    const deltaMonthly = result.actual_costs.total_monthly - result.planned_costs.total_monthly;
    const deltaYearly = result.actual_costs.total_yearly - result.planned_costs.total_yearly;
    const pctChange =
      result.planned_costs.total_monthly === 0
        ? result.actual_costs.total_monthly === 0
          ? 0
          : 100
        : Math.round((deltaMonthly / result.planned_costs.total_monthly) * 10000) / 100;

    result.delta = {
      monthly: Math.round(deltaMonthly * 100) / 100,
      yearly: Math.round(deltaYearly * 100) / 100,
      pct_change: pctChange,
    };
  }

  // -------------------------------------------------------------------------
  // Currency conversion
  // -------------------------------------------------------------------------
  if (currency !== "USD") {
    result.exchange_rate = getExchangeRateInfo(currency);
    // Re-calculate through the conversion utility by wrapping in a breakdown
    const actualConverted = convertBreakdownCurrency(actualBreakdown, currency);
    result.actual_costs.total_monthly = Math.round(actualConverted.total_monthly * 100) / 100;
    result.actual_costs.total_yearly = Math.round(actualConverted.total_monthly * 12 * 100) / 100;
    result.actual_costs.by_resource = actualConverted.by_resource.map((r) => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type,
      monthly_cost: Math.round(r.monthly_cost * 100) / 100,
    }));

    if (result.planned_costs && result.delta) {
      // Recalculate delta after currency conversion
      const deltaMonthly = result.actual_costs.total_monthly - result.planned_costs.total_monthly;
      result.delta.monthly = Math.round(deltaMonthly * 100) / 100;
      result.delta.yearly = Math.round(deltaMonthly * 12 * 100) / 100;
    }
  }

  // Deduplicate warnings
  result.warnings = [...new Set(warnings)];

  return result;
}
