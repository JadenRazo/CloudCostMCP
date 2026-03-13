import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Static pricing tables (bundled)
// ---------------------------------------------------------------------------

// AWS ECR: $0.10/GB-month for storage
const AWS_ECR_STORAGE_PRICE_PER_GB = 0.10;

// Azure Container Registry pricing per GB-month by tier
const AZURE_ACR_STORAGE_PRICE: Record<string, number> = {
  basic: 0.167,
  standard: 0.667,
  premium: 1.667,
};

// GCP Artifact Registry: $0.10/GB-month for storage
const GCP_ARTIFACT_REGISTRY_STORAGE_PRICE_PER_GB = 0.10;

// Default storage assumption when no storage_gb attribute is specified
const DEFAULT_STORAGE_GB = 10;

/**
 * Calculates the monthly cost for a container registry resource.
 *
 * Pricing is based on stored image data (GB/month). Azure additionally
 * distinguishes between Basic, Standard, and Premium tiers which each have
 * different per-GB storage rates.
 *
 * Cost = storage_gb * price_per_gb
 */
export function calculateContainerRegistryCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const storageGb =
    (resource.attributes.storage_gb as number | undefined) ??
    (resource.attributes.storage_size_gb as number | undefined);

  const hasExplicitStorage = storageGb !== undefined && storageGb > 0;
  const resolvedStorageGb = hasExplicitStorage ? storageGb! : DEFAULT_STORAGE_GB;

  if (!hasExplicitStorage) {
    notes.push(
      `No storage_gb specified; assuming ${DEFAULT_STORAGE_GB} GB for container registry cost estimate`
    );
  }

  let pricePerGb: number;
  let tierLabel: string;

  if (targetProvider === "aws") {
    pricePerGb = AWS_ECR_STORAGE_PRICE_PER_GB;
    tierLabel = "ECR";
  } else if (targetProvider === "azure") {
    const rawSku = (resource.attributes.sku as string | undefined) ?? "Basic";
    const sku = rawSku.toLowerCase();
    pricePerGb = AZURE_ACR_STORAGE_PRICE[sku] ?? AZURE_ACR_STORAGE_PRICE["basic"];
    tierLabel = `ACR ${rawSku}`;
    if (!AZURE_ACR_STORAGE_PRICE[sku]) {
      notes.push(
        `Unknown Azure Container Registry SKU "${rawSku}"; defaulting to Basic tier pricing`
      );
    }
  } else {
    // gcp
    pricePerGb = GCP_ARTIFACT_REGISTRY_STORAGE_PRICE_PER_GB;
    tierLabel = "Artifact Registry";
  }

  const storageCost = pricePerGb * resolvedStorageGb;

  breakdown.push({
    description: `${tierLabel} storage (${resolvedStorageGb} GB)`,
    unit: "GB-Mo",
    quantity: resolvedStorageGb,
    unit_price: pricePerGb,
    monthly_cost: storageCost,
  });

  const totalMonthly = storageCost;

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
    confidence: hasExplicitStorage ? "high" : "medium",
    notes,
    pricing_source: "bundled",
  };
}
