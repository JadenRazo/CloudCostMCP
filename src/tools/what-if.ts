import { z } from "zod";
import type { CloudProvider, ParsedResource } from "../types/resources.js";
import type { CloudCostConfig } from "../types/config.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { parseTerraform } from "../parsers/index.js";
import { mapRegion } from "../mapping/region-mapper.js";
import { CostEngine } from "../calculator/cost-engine.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const whatIfSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("File path"),
      content: z.string().describe("File content (HCL)"),
    })
  ).describe("Terraform HCL files to analyse"),
  changes: z.array(
    z.object({
      resource_id: z
        .string()
        .describe("The resource ID to modify (e.g. aws_instance.web)"),
      attribute: z
        .string()
        .describe(
          "The attribute name to change (e.g. instance_type, storage_size_gb)"
        ),
      new_value: z
        .union([z.string(), z.number()])
        .describe("The new value for the attribute"),
    })
  ).describe("List of attribute changes to simulate"),
  provider: z
    .enum(["aws", "azure", "gcp"])
    .optional()
    .describe("Target cloud provider. Defaults to auto-detecting from the files"),
  region: z
    .string()
    .optional()
    .describe("Target region for pricing. Defaults to the region detected from provider blocks"),
  tfvars: z
    .string()
    .optional()
    .describe("Contents of a terraform.tfvars file for variable resolution"),
});

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ResourceDiff {
  resource_id: string;
  resource_type: string;
  resource_name: string;
  original_monthly: number;
  new_monthly: number;
  delta_monthly: number;
  pct_change: number;
  currency: string;
  changes_applied: Array<{ attribute: string; new_value: string | number }>;
}

export interface WhatIfResult {
  provider: CloudProvider;
  region: string;
  original_total_monthly: number;
  new_total_monthly: number;
  total_delta_monthly: number;
  total_delta_yearly: number;
  total_pct_change: number;
  currency: string;
  resource_diffs: ResourceDiff[];
  changes_applied: Array<{
    resource_id: string;
    attribute: string;
    new_value: string | number;
  }>;
  warnings: string[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Deep clone helper (avoids mutating the original resource list)
// ---------------------------------------------------------------------------

function cloneResources(resources: ParsedResource[]): ParsedResource[] {
  return JSON.parse(JSON.stringify(resources)) as ParsedResource[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Estimate the cost impact of a set of attribute changes on Terraform
 * resources without modifying any files on disk.
 *
 * The handler:
 *  1. Parses the supplied Terraform files to build a ResourceInventory.
 *  2. Runs CostEngine.calculateBreakdown on the unmodified resources.
 *  3. Deep-clones the resource list and applies the requested changes.
 *  4. Runs CostEngine.calculateBreakdown on the modified resources.
 *  5. Produces a per-resource diff and an aggregate total diff.
 */
export async function whatIf(
  params: z.infer<typeof whatIfSchema>,
  pricingEngine: PricingEngine,
  config: CloudCostConfig
): Promise<WhatIfResult> {
  const inventory = await parseTerraform(params.files, params.tfvars);

  const targetProvider: CloudProvider =
    (params.provider as CloudProvider | undefined) ?? inventory.provider;

  const targetRegion =
    params.region ??
    mapRegion(inventory.region, inventory.provider, targetProvider);

  const costEngine = new CostEngine(pricingEngine, config);

  // -------------------------------------------------------------------------
  // Baseline cost
  // -------------------------------------------------------------------------
  const originalBreakdown = await costEngine.calculateBreakdown(
    inventory.resources,
    targetProvider,
    targetRegion
  );

  // -------------------------------------------------------------------------
  // Apply changes to a cloned resource set
  // -------------------------------------------------------------------------
  const modifiedResources = cloneResources(inventory.resources);
  const warnings: string[] = [
    ...(inventory.parse_warnings ?? []),
    ...(originalBreakdown.warnings ?? []),
  ];
  const changesApplied: WhatIfResult["changes_applied"] = [];

  for (const change of params.changes) {
    const resource = modifiedResources.find(
      (r) => r.id === change.resource_id
    );

    if (!resource) {
      const msg = `what-if: resource_id "${change.resource_id}" not found — change skipped`;
      warnings.push(msg);
      logger.warn(msg, { resource_id: change.resource_id });
      continue;
    }

    // Apply to the typed attributes bag first; if the attribute is not a
    // recognised ResourceAttributes key, fall back to the index signature.
    (resource.attributes as Record<string, unknown>)[change.attribute] =
      change.new_value;

    changesApplied.push({
      resource_id: change.resource_id,
      attribute: change.attribute,
      new_value: change.new_value,
    });

    logger.debug("what-if: applied change", {
      resource_id: change.resource_id,
      attribute: change.attribute,
      new_value: change.new_value,
    });
  }

  // -------------------------------------------------------------------------
  // Modified cost
  // -------------------------------------------------------------------------
  const modifiedBreakdown = await costEngine.calculateBreakdown(
    modifiedResources,
    targetProvider,
    targetRegion
  );

  // Merge any additional warnings from the modified run, deduplicating.
  const allWarnings = [
    ...new Set([...warnings, ...(modifiedBreakdown.warnings ?? [])]),
  ];

  // -------------------------------------------------------------------------
  // Build per-resource diffs
  // -------------------------------------------------------------------------
  const resourceDiffs: ResourceDiff[] = [];

  // Index original estimates by resource_id for O(1) lookup.
  const originalByResource = new Map(
    originalBreakdown.by_resource.map((e) => [e.resource_id, e])
  );
  const modifiedByResource = new Map(
    modifiedBreakdown.by_resource.map((e) => [e.resource_id, e])
  );

  // Gather all resource IDs from both runs (handles additions/removals).
  const allIds = new Set([
    ...originalByResource.keys(),
    ...modifiedByResource.keys(),
  ]);

  // Build a lookup from resource_id to the changes that were applied to it.
  const changesByResourceId = new Map<
    string,
    Array<{ attribute: string; new_value: string | number }>
  >();
  for (const c of changesApplied) {
    const existing = changesByResourceId.get(c.resource_id) ?? [];
    existing.push({ attribute: c.attribute, new_value: c.new_value });
    changesByResourceId.set(c.resource_id, existing);
  }

  for (const id of allIds) {
    const orig = originalByResource.get(id);
    const mod = modifiedByResource.get(id);

    const origMonthly = orig?.monthly_cost ?? 0;
    const newMonthly = mod?.monthly_cost ?? 0;
    const delta = newMonthly - origMonthly;
    const pctChange =
      origMonthly === 0
        ? newMonthly === 0
          ? 0
          : 100
        : Math.round((delta / origMonthly) * 10000) / 100;

    resourceDiffs.push({
      resource_id: id,
      resource_type: (orig ?? mod)!.resource_type,
      resource_name: (orig ?? mod)!.resource_name,
      original_monthly: Math.round(origMonthly * 100) / 100,
      new_monthly: Math.round(newMonthly * 100) / 100,
      delta_monthly: Math.round(delta * 100) / 100,
      pct_change: pctChange,
      currency: (orig ?? mod)!.currency,
      changes_applied: changesByResourceId.get(id) ?? [],
    });
  }

  // -------------------------------------------------------------------------
  // Aggregate totals
  // -------------------------------------------------------------------------
  const origTotal = originalBreakdown.total_monthly;
  const newTotal = modifiedBreakdown.total_monthly;
  const totalDelta = Math.round((newTotal - origTotal) * 100) / 100;
  const totalPct =
    origTotal === 0
      ? newTotal === 0
        ? 0
        : 100
      : Math.round(((newTotal - origTotal) / origTotal) * 10000) / 100;

  return {
    provider: targetProvider,
    region: targetRegion,
    original_total_monthly: Math.round(origTotal * 100) / 100,
    new_total_monthly: Math.round(newTotal * 100) / 100,
    total_delta_monthly: totalDelta,
    total_delta_yearly: Math.round(totalDelta * 12 * 100) / 100,
    total_pct_change: totalPct,
    currency: "USD",
    resource_diffs: resourceDiffs,
    changes_applied: changesApplied,
    warnings: allWarnings,
    generated_at: new Date().toISOString(),
  };
}
