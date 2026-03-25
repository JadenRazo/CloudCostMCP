import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import { mapInstance } from "../mapping/instance-mapper.js";
import { logger } from "../logger.js";

// AWS RDS instance classes use the "db." prefix. For spec-based mapping to
// Azure/GCP we strip the prefix, find the nearest compute equivalent, and
// then translate back to a DB tier identifier.
function normalizeDbInstanceClass(instanceClass: string): string {
  return instanceClass.startsWith("db.") ? instanceClass.slice(3) : instanceClass;
}

/**
 * Calculates the monthly cost for a managed database instance on a target
 * provider.
 *
 * Handles:
 *  - AWS RDS (db.* instance classes)
 *  - Azure Flexible Server / SQL MI tiers
 *  - GCP Cloud SQL (db-custom-* tiers)
 *  - Multi-AZ: doubles the instance cost for AWS, uses ha_multiplier for GCP
 *  - Allocated storage pricing
 */
export async function calculateDatabaseCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
  monthlyHours: number = 730
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  // Resolve source DB instance class across provider attribute conventions.
  const sourceInstanceClass =
    (resource.attributes.instance_class as string | undefined) ??
    (resource.attributes.instance_type as string | undefined) ??
    (resource.attributes.vm_size as string | undefined) ??
    (resource.attributes.tier as string | undefined) ??
    "";

  const isMultiAz = Boolean(resource.attributes.multi_az);
  const allocatedStorageGb =
    (resource.attributes.allocated_storage as number | undefined) ??
    (resource.attributes.storage_size_gb as number | undefined) ??
    0;
  const engine =
    (resource.attributes.engine as string | undefined) ?? "MySQL";

  // Map instance class to target provider equivalent.
  // Strip the "db." prefix for AWS classes before feeding into the generic
  // instance mapper, then try to map back with the db. prefix for the target.
  const normalised = normalizeDbInstanceClass(sourceInstanceClass);

  let mappedInstance: string | null = null;

  if (targetProvider === "gcp") {
    // GCP uses db-custom-* naming; try direct map first, then find nearest.
    mappedInstance = mapInstance(sourceInstanceClass, resource.provider, "gcp");
    if (!mappedInstance) {
      // Try stripping db. prefix and mapping from normalized class.
      mappedInstance = mapInstance(normalised, resource.provider, "gcp");
    }
    // Prefer a db-custom-* type for GCP databases.
    if (mappedInstance && !mappedInstance.startsWith("db-")) {
      // If we got a compute machine type, try to find the db equivalent.
      const dbMapped = mapInstance(sourceInstanceClass, resource.provider, "gcp");
      if (dbMapped) mappedInstance = dbMapped;
    }
  } else if (targetProvider === "aws") {
    // Ensure the result has the db. prefix for RDS.
    mappedInstance = mapInstance(sourceInstanceClass, resource.provider, "aws");
    if (!mappedInstance && normalised !== sourceInstanceClass) {
      mappedInstance = mapInstance(normalised, resource.provider, "aws");
    }
    if (mappedInstance && !mappedInstance.startsWith("db.")) {
      mappedInstance = `db.${mappedInstance}`;
    }
  } else {
    // Azure: use the instance mapper directly.
    mappedInstance = mapInstance(sourceInstanceClass, resource.provider, targetProvider);
    if (!mappedInstance) {
      mappedInstance = mapInstance(normalised, resource.provider, targetProvider);
    }
  }

  const effectiveInstance = mappedInstance ?? sourceInstanceClass;

  if (!mappedInstance) {
    notes.push(
      `No DB instance mapping found for ${sourceInstanceClass} (${resource.provider} -> ${targetProvider}); using source class`
    );
  }

  // Fetch DB price.
  const dbPrice = await pricingEngine
    .getProvider(targetProvider)
    .getDatabasePrice(effectiveInstance, targetRegion, engine);

  let instanceMonthlyCost = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (dbPrice) {
    const rawSource = dbPrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      pricingSource = "bundled";
    } else if (rawSource === "fallback") {
      pricingSource = "fallback";
      notes.push(`Pricing for ${effectiveInstance} uses bundled fallback data (live API unavailable)`);
    } else {
      pricingSource = "live";
    }

    instanceMonthlyCost = dbPrice.price_per_unit * monthlyHours;

    // For GCP, apply the HA multiplier from the pricing data when multi-AZ.
    let haMultiplier = 1;
    if (isMultiAz) {
      if (targetProvider === "gcp") {
        const gcpMult = parseFloat(
          dbPrice.attributes?.ha_multiplier ?? "2"
        );
        haMultiplier = isNaN(gcpMult) ? 2 : gcpMult;
      } else {
        haMultiplier = 2;
      }
      notes.push(`Multi-AZ enabled: instance cost multiplied by ${haMultiplier}`);
    }

    const adjustedCost = instanceMonthlyCost * haMultiplier;
    breakdown.push({
      description: `${effectiveInstance} DB instance (${monthlyHours}h/month)${isMultiAz ? " x" + haMultiplier + " (Multi-AZ)" : ""}`,
      unit: "Hrs",
      quantity: monthlyHours * haMultiplier,
      unit_price: dbPrice.price_per_unit,
      monthly_cost: adjustedCost,
    });
    instanceMonthlyCost = adjustedCost;
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
    logger.debug("calculateDatabaseCost: no price", {
      effectiveInstance,
      targetRegion,
    });
  }

  // Storage cost.
  let storageMonthlyCost = 0;
  if (allocatedStorageGb > 0) {
    // Use gp3 as the default EBS-style storage type for DB storage pricing.
    const storageType =
      (resource.attributes.storage_type as string | undefined) ?? "gp3";

    const storagePrice = await pricingEngine
      .getProvider(targetProvider)
      .getStoragePrice(storageType, targetRegion, allocatedStorageGb);

    if (storagePrice) {
      storageMonthlyCost = storagePrice.price_per_unit * allocatedStorageGb;
      breakdown.push({
        description: `DB storage ${storageType} (${allocatedStorageGb} GB)`,
        unit: "GB-Mo",
        quantity: allocatedStorageGb,
        unit_price: storagePrice.price_per_unit,
        monthly_cost: storageMonthlyCost,
      });
    }
  }

  const totalMonthly = instanceMonthlyCost + storageMonthlyCost;

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
    confidence: mappedInstance ? "high" : "low",
    notes,
    pricing_source: pricingSource,
  };
}
