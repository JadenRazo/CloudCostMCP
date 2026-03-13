import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";
import type { PricingEngine } from "../pricing/pricing-engine.js";
import type { PricingConfig } from "../types/config.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import { mapInstance } from "../mapping/instance-mapper.js";
import { mapStorageType } from "../mapping/storage-mapper.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Spot discount factors per provider and instance family category.
// These represent the fraction of on-demand price paid for spot/preemptible
// instances (e.g. 0.35 means 65% savings, paying 35% of on-demand rate).
// ---------------------------------------------------------------------------

const SPOT_DISCOUNT_FACTORS: Record<CloudProvider, Record<string, number>> = {
  aws: {
    general:  0.35,
    compute:  0.30,
    memory:   0.35,
    gpu:      0.40,
  },
  azure: {
    general:  0.35,
    compute:  0.30,
    memory:   0.35,
    gpu:      0.40,
  },
  gcp: {
    general:  0.30,
    compute:  0.25,
    memory:   0.30,
    gpu:      0.35,
  },
};

/**
 * Classifies an instance type string into a broad family category so the
 * correct spot discount factor can be selected.
 *
 * AWS examples:   m5, m6i → general | c5, c6g → compute | r5, x1 → memory | p3, g4dn → gpu
 * Azure examples: Standard_D → general | Standard_F → compute | Standard_E, Standard_M → memory | Standard_N → gpu
 * GCP examples:   n2, e2 → general | c2 → compute | m1, m2 → memory | a2 → gpu
 */
function classifyInstanceFamily(instanceType: string, provider: CloudProvider): string {
  const t = instanceType.toLowerCase();

  if (provider === "aws") {
    if (/^(p\d|g\d|inf\d)/.test(t)) return "gpu";
    if (/^(r\d|x\d|u-|z\d|cr\d)/.test(t)) return "memory";
    if (/^(c\d|hpc)/.test(t)) return "compute";
    return "general";
  }

  if (provider === "azure") {
    if (/standard_n/i.test(t)) return "gpu";
    if (/standard_(e|m)/i.test(t)) return "memory";
    if (/standard_f/i.test(t)) return "compute";
    return "general";
  }

  if (provider === "gcp") {
    if (/^a\d/.test(t)) return "gpu";
    if (/^(m\d|ultramem)/.test(t)) return "memory";
    if (/^c\d/.test(t)) return "compute";
    return "general";
  }

  return "general";
}

/**
 * Calculates the monthly compute cost for a VM-style resource on a target
 * provider.
 *
 * The function:
 *  1. Resolves the target instance type via exact or nearest-match mapping.
 *  2. Fetches the hourly on-demand price from the pricing engine.
 *  3. Optionally applies a spot/preemptible discount when pricingConfig.pricing_model
 *     is set to "spot". The discount factor is chosen per provider and instance family.
 *  4. Adds optional root block device (EBS/disk) storage cost when present.
 *  5. Returns a CostEstimate whose confidence reflects whether the instance
 *     mapping was exact ("high") or approximate ("medium").
 */
export async function calculateComputeCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
  pricingEngine: PricingEngine,
  monthlyHours: number = 730,
  pricingConfig: PricingConfig = DEFAULT_CONFIG.pricing
): Promise<CostEstimate> {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  // Determine source instance type attribute regardless of provider.
  const sourceInstanceType =
    (resource.attributes.instance_type as string | undefined) ??
    (resource.attributes.vm_size as string | undefined) ??
    (resource.attributes.machine_type as string | undefined) ??
    "";

  // Map instance type to target provider.
  const mappedInstance = sourceInstanceType
    ? mapInstance(sourceInstanceType, resource.provider, targetProvider)
    : null;

  let confidence: "high" | "medium" | "low" = "low";
  let specBasedMapping = false;

  if (!mappedInstance) {
    notes.push(
      `No instance mapping found for ${sourceInstanceType} (${resource.provider} -> ${targetProvider})`
    );
  } else {
    // Check whether the mapping came from the direct table or was approximate.
    // We infer this by checking if the instance map contains an exact entry;
    // the mapper itself returns null for both "not found" and "spec-fallback"
    // scenarios without exposing which path was taken. We approximate by
    // looking at whether instance names are literally the same shape.
    const { getInstanceMap } = await import("../data/loader.js");
    const im = getInstanceMap();
    const dirKey = `${resource.provider}_to_${targetProvider}` as keyof typeof im;
    const directMap = im[dirKey] as Record<string, string> | undefined;
    const isExact = directMap?.[sourceInstanceType] === mappedInstance;
    confidence = isExact ? "high" : "medium";

    if (!isExact) {
      specBasedMapping = true;
      notes.push(
        `Instance mapping for ${sourceInstanceType} -> ${mappedInstance} is an approximate spec-based match`
      );
    }
  }

  const effectiveInstance = mappedInstance ?? sourceInstanceType;

  // Fetch compute price.
  const computePrice = effectiveInstance
    ? await pricingEngine
        .getProvider(targetProvider)
        .getComputePrice(effectiveInstance, targetRegion, resource.attributes.os as string | undefined)
    : null;

  let computeMonthlyCost = 0;
  let pricingSource: "live" | "fallback" | "bundled" | "spot-estimate" = "fallback";

  if (computePrice) {
    const rawSource = computePrice.attributes?.pricing_source;
    if (rawSource === "bundled") {
      pricingSource = "bundled";
    } else if (rawSource === "fallback") {
      pricingSource = "fallback";
      notes.push(`Pricing for ${effectiveInstance} uses bundled fallback data (live API unavailable)`);
    } else {
      pricingSource = "live";
    }

    if (specBasedMapping) {
      notes.push(`Spec-based instance mapping used: ${sourceInstanceType} -> ${mappedInstance}`);
    }

    let hourlyPrice = computePrice.price_per_unit;

    // Apply spot/preemptible discount when requested.
    if (pricingConfig.pricing_model === "spot") {
      const family = classifyInstanceFamily(effectiveInstance, targetProvider);
      const providerFactors = SPOT_DISCOUNT_FACTORS[targetProvider] ?? SPOT_DISCOUNT_FACTORS.aws;
      const factor = providerFactors[family] ?? providerFactors.general ?? 0.35;
      const savingsPct = Math.round((1 - factor) * 100);

      hourlyPrice = hourlyPrice * factor;
      pricingSource = "spot-estimate";
      notes.push(
        `Spot pricing applied (${savingsPct}% discount from on-demand)`
      );
    }

    computeMonthlyCost = hourlyPrice * monthlyHours;

    breakdown.push({
      description: `${effectiveInstance} compute (${monthlyHours}h/month)`,
      unit: "Hrs",
      quantity: monthlyHours,
      unit_price: hourlyPrice,
      monthly_cost: computeMonthlyCost,
    });
  } else {
    notes.push(`No pricing data found for ${resource.type} in ${targetRegion}`);
    confidence = "low";
    pricingSource = "fallback";
  }

  // Add root block device / disk storage cost if specified.
  let storageMonthlyCost = 0;
  const rootDisk = resource.attributes.root_block_device as
    | { volume_type?: string; volume_size?: number }
    | undefined;
  const storageType =
    (rootDisk?.volume_type as string | undefined) ??
    (resource.attributes.storage_type as string | undefined);
  const storageSizeGb =
    (rootDisk?.volume_size as number | undefined) ??
    (resource.attributes.storage_size_gb as number | undefined);

  if (storageType && storageSizeGb && storageSizeGb > 0) {
    const mappedStorageType = mapStorageType(
      storageType,
      resource.provider,
      targetProvider
    ) ?? storageType;

    const storagePrice = await pricingEngine
      .getProvider(targetProvider)
      .getStoragePrice(mappedStorageType, targetRegion, storageSizeGb);

    if (storagePrice) {
      storageMonthlyCost = storagePrice.price_per_unit * storageSizeGb;
      breakdown.push({
        description: `Root disk ${mappedStorageType} (${storageSizeGb} GB)`,
        unit: "GB-Mo",
        quantity: storageSizeGb,
        unit_price: storagePrice.price_per_unit,
        monthly_cost: storageMonthlyCost,
      });
    } else {
      logger.debug("calculateComputeCost: no storage price found", {
        mappedStorageType,
        targetRegion,
      });
    }
  }

  const totalMonthly = computeMonthlyCost + storageMonthlyCost;

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
    confidence,
    notes,
    pricing_source: pricingSource,
  };
}
