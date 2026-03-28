import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Static pricing tables (bundled)
// ---------------------------------------------------------------------------

// AWS Secrets Manager
// $0.40 per secret per month
// $0.05 per 10,000 API calls
const AWS_SECRETS_MANAGER_PER_SECRET = 0.4;
const AWS_SECRETS_MANAGER_PER_10K_API_CALLS = 0.05;

// Azure Key Vault
// Standard tier: $0.03 per 10,000 secret operations
// (Key operations at basic tier are free; we model only secret operations)
const AZURE_KEY_VAULT_PER_10K_OPERATIONS = 0.03;

// GCP Secret Manager
// $0.06 per active secret version per month
// $0.03 per 10,000 access operations
const GCP_SECRET_MANAGER_PER_VERSION = 0.06;
const GCP_SECRET_MANAGER_PER_10K_ACCESS_OPS = 0.03;

// Default assumptions when not specified in resource attributes
const DEFAULT_SECRET_COUNT = 1;
const DEFAULT_API_CALLS_PER_MONTH = 10_000;

/**
 * Calculates the monthly cost for a secrets management resource.
 *
 * AWS Secrets Manager: per-secret monthly fee + API call charges
 * Azure Key Vault:     per-operation charges (secret operations)
 * GCP Secret Manager: per-version monthly fee + access operation charges
 */
export function calculateSecretsCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const secretCount =
    (resource.attributes.secret_count as number | undefined) ??
    (resource.attributes.versions as number | undefined) ??
    DEFAULT_SECRET_COUNT;

  const hasExplicitSecretCount =
    resource.attributes.secret_count !== undefined || resource.attributes.versions !== undefined;

  if (!hasExplicitSecretCount) {
    notes.push(
      `No secret_count specified; assuming ${DEFAULT_SECRET_COUNT} secret for cost estimate`,
    );
  }

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    // Per-secret monthly fee
    const secretFee = AWS_SECRETS_MANAGER_PER_SECRET * secretCount;
    breakdown.push({
      description: `Secrets Manager secret storage (${secretCount} secret${secretCount !== 1 ? "s" : ""})`,
      unit: "secrets/Mo",
      quantity: secretCount,
      unit_price: AWS_SECRETS_MANAGER_PER_SECRET,
      monthly_cost: secretFee,
    });
    totalMonthly += secretFee;

    // API call charges
    const apiCalls =
      (resource.attributes.api_calls_per_month as number | undefined) ??
      DEFAULT_API_CALLS_PER_MONTH;

    if (!resource.attributes.api_calls_per_month) {
      notes.push(
        `API call volume not specified; assuming ${DEFAULT_API_CALLS_PER_MONTH.toLocaleString()} calls/month`,
      );
    }

    const apiCallsIn10K = apiCalls / 10_000;
    const apiCallFee = AWS_SECRETS_MANAGER_PER_10K_API_CALLS * apiCallsIn10K;
    breakdown.push({
      description: `Secrets Manager API calls (${apiCalls.toLocaleString()} calls/month)`,
      unit: "10K calls",
      quantity: apiCallsIn10K,
      unit_price: AWS_SECRETS_MANAGER_PER_10K_API_CALLS,
      monthly_cost: apiCallFee,
    });
    totalMonthly += apiCallFee;
  } else if (targetProvider === "azure") {
    // Secret operations (standard tier)
    const operations =
      (resource.attributes.operations_per_month as number | undefined) ??
      DEFAULT_API_CALLS_PER_MONTH;

    if (!resource.attributes.operations_per_month) {
      notes.push(
        `Operation count not specified; assuming ${DEFAULT_API_CALLS_PER_MONTH.toLocaleString()} operations/month`,
      );
    }

    const operationsIn10K = operations / 10_000;
    const operationFee = AZURE_KEY_VAULT_PER_10K_OPERATIONS * operationsIn10K;
    breakdown.push({
      description: `Key Vault secret operations (${operations.toLocaleString()} ops/month, Standard tier)`,
      unit: "10K ops",
      quantity: operationsIn10K,
      unit_price: AZURE_KEY_VAULT_PER_10K_OPERATIONS,
      monthly_cost: operationFee,
    });
    totalMonthly += operationFee;

    notes.push(
      "Azure Key Vault basic-tier key operations are free; only secret operation charges are included",
    );
  } else {
    // gcp
    // Per active secret version fee
    const versionFee = GCP_SECRET_MANAGER_PER_VERSION * secretCount;
    breakdown.push({
      description: `Secret Manager active versions (${secretCount} version${secretCount !== 1 ? "s" : ""})`,
      unit: "versions/Mo",
      quantity: secretCount,
      unit_price: GCP_SECRET_MANAGER_PER_VERSION,
      monthly_cost: versionFee,
    });
    totalMonthly += versionFee;

    // Access operation charges
    const accessOps =
      (resource.attributes.access_operations_per_month as number | undefined) ??
      DEFAULT_API_CALLS_PER_MONTH;

    if (!resource.attributes.access_operations_per_month) {
      notes.push(
        `Access operation count not specified; assuming ${DEFAULT_API_CALLS_PER_MONTH.toLocaleString()} access ops/month`,
      );
    }

    const accessOpsIn10K = accessOps / 10_000;
    const accessOpFee = GCP_SECRET_MANAGER_PER_10K_ACCESS_OPS * accessOpsIn10K;
    breakdown.push({
      description: `Secret Manager access operations (${accessOps.toLocaleString()} ops/month)`,
      unit: "10K ops",
      quantity: accessOpsIn10K,
      unit_price: GCP_SECRET_MANAGER_PER_10K_ACCESS_OPS,
      monthly_cost: accessOpFee,
    });
    totalMonthly += accessOpFee;
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
    confidence: hasExplicitSecretCount ? "high" : "medium",
    notes,
    pricing_source: "bundled",
  };
}
