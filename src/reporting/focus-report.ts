import type { ProviderComparison } from "../types/pricing.js";
import type { ParsedResource } from "../types/resources.js";
import { csvEscape } from "./csv-escape.js";

// FOCUS column headers per the FinOps Open Cost and Usage Specification.
const FOCUS_HEADERS = [
  "BillingAccountId",
  "BillingPeriodStart",
  "BillingPeriodEnd",
  "ChargeType",
  "Provider",
  "ServiceName",
  "ServiceCategory",
  "ResourceId",
  "ResourceName",
  "ResourceType",
  "Region",
  "PricingUnit",
  "PricingQuantity",
  "EffectiveCost",
  "ListCost",
  "ListUnitPrice",
  "Currency",
] as const;

// ---------------------------------------------------------------------------
// Service name and category derivation
// ---------------------------------------------------------------------------

/**
 * Maps a Terraform resource type to a human-readable service name following
 * each cloud provider's own naming conventions (e.g. "Amazon EC2").
 */
function deriveServiceName(resourceType: string, provider: string): string {
  const t = resourceType.toLowerCase();

  // Compute
  if (t.includes("instance") || t.includes("vm") || t.includes("virtual_machine")) {
    if (provider === "aws") return "Amazon EC2";
    if (provider === "azure") return "Azure Virtual Machines";
    return "Google Compute Engine";
  }

  // Kubernetes / containers
  if (t.includes("cluster") || t.includes("node_pool") || t.includes("node_group")) {
    if (provider === "aws") return "Amazon EKS";
    if (provider === "azure") return "Azure Kubernetes Service";
    return "Google Kubernetes Engine";
  }

  // Database
  if (
    t.includes("db_instance") ||
    t.includes("database") ||
    t.includes("sql") ||
    t.includes("rds")
  ) {
    if (provider === "aws") return "Amazon RDS";
    if (provider === "azure") return "Azure SQL Database";
    return "Cloud SQL";
  }

  // Storage
  if (
    t.includes("bucket") ||
    t.includes("storage") ||
    t.includes("disk") ||
    t.includes("ebs") ||
    t.includes("blob")
  ) {
    if (provider === "aws") return "Amazon S3";
    if (provider === "azure") return "Azure Blob Storage";
    return "Google Cloud Storage";
  }

  // Network / load balancer
  if (
    t.includes("lb") ||
    t.includes("load_balancer") ||
    t.includes("elb") ||
    t.includes("alb") ||
    t.includes("nat") ||
    t.includes("gateway")
  ) {
    if (provider === "aws") return "Elastic Load Balancing";
    if (provider === "azure") return "Azure Load Balancer";
    return "Cloud Load Balancing";
  }

  // DNS
  if (t.includes("dns") || t.includes("route53") || t.includes("zone")) {
    if (provider === "aws") return "Amazon Route 53";
    if (provider === "azure") return "Azure DNS";
    return "Cloud DNS";
  }

  // Secrets / key management
  if (
    t.includes("secret") ||
    t.includes("kms") ||
    t.includes("key_vault") ||
    t.includes("ssm_parameter")
  ) {
    if (provider === "aws") return "AWS Secrets Manager";
    if (provider === "azure") return "Azure Key Vault";
    return "Secret Manager";
  }

  // Container registry
  if (t.includes("ecr") || t.includes("container_registry") || t.includes("artifact")) {
    if (provider === "aws") return "Amazon ECR";
    if (provider === "azure") return "Azure Container Registry";
    return "Artifact Registry";
  }

  return "Other";
}

/**
 * Maps a Terraform resource type to a FOCUS-compliant service category.
 */
export function deriveServiceCategory(resourceType: string): string {
  const t = resourceType.toLowerCase();

  // Database check must come before the generic "instance" check because
  // resource types like "aws_db_instance" and "google_sql_database_instance"
  // contain the substring "instance" but belong to the Database category.
  if (
    t.includes("db_instance") ||
    t.includes("database") ||
    t.includes("sql") ||
    t.includes("rds") ||
    t.includes("dynamo") ||
    t.includes("cosmos") ||
    t.includes("firestore") ||
    t.includes("bigtable") ||
    t.includes("spanner") ||
    t.includes("redis") ||
    t.includes("memcache") ||
    t.includes("elasticache")
  ) {
    return "Database";
  }

  if (
    t.includes("instance") ||
    t.includes("vm") ||
    t.includes("virtual_machine") ||
    t.includes("machine_type") ||
    t.includes("cluster") ||
    t.includes("node_pool") ||
    t.includes("node_group")
  ) {
    return "Compute";
  }

  if (
    t.includes("bucket") ||
    t.includes("storage") ||
    t.includes("disk") ||
    t.includes("ebs") ||
    t.includes("blob") ||
    t.includes("s3") ||
    t.includes("efs") ||
    t.includes("fsx")
  ) {
    return "Storage";
  }

  if (
    t.includes("lb") ||
    t.includes("load_balancer") ||
    t.includes("elb") ||
    t.includes("alb") ||
    t.includes("nat") ||
    t.includes("gateway") ||
    t.includes("vpc") ||
    t.includes("subnet") ||
    t.includes("route") ||
    t.includes("dns") ||
    t.includes("zone") ||
    t.includes("cdn") ||
    t.includes("cloudfront") ||
    t.includes("waf")
  ) {
    return "Network";
  }

  if (
    t.includes("secret") ||
    t.includes("kms") ||
    t.includes("key_vault") ||
    t.includes("ssm_parameter") ||
    t.includes("certificate") ||
    t.includes("iam") ||
    t.includes("policy") ||
    t.includes("role")
  ) {
    return "Security";
  }

  if (
    t.includes("ecr") ||
    t.includes("container_registry") ||
    t.includes("artifact") ||
    t.includes("lambda") ||
    t.includes("function") ||
    t.includes("app_service")
  ) {
    return "Developer Tools";
  }

  return "Other";
}

// ---------------------------------------------------------------------------
// Pricing unit / quantity helpers
// ---------------------------------------------------------------------------

/**
 * Returns the FOCUS PricingUnit appropriate for the given resource type.
 *  - Compute resources are billed per hour → "Hours"
 *  - Storage resources are billed per GB per month → "GB-Month"
 *  - Everything else → "Units"
 */
function derivePricingUnit(resourceType: string): string {
  const category = deriveServiceCategory(resourceType);
  if (category === "Compute" || category === "Database") return "Hours";
  if (category === "Storage") return "GB-Month";
  return "Units";
}

/**
 * Returns a sensible PricingQuantity for the given resource.
 *  - Hourly resources: 730 (standard monthly hours)
 *  - Storage resources: storage size in GB if available, otherwise 1
 *  - Other: 1
 */
function derivePricingQuantity(resource: ParsedResource): number {
  const unit = derivePricingUnit(resource.type);
  if (unit === "Hours") return 730;
  if (unit === "GB-Month") {
    const sizeGb = resource.attributes.storage_size_gb;
    if (typeof sizeGb === "number" && sizeGb > 0) return sizeGb;
    return 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Billing period helpers
// ---------------------------------------------------------------------------

function billingPeriodStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0]!;
}

function billingPeriodEnd(): string {
  const now = new Date();
  // First day of next month = last day of this month + 1.
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split("T")[0]!;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function buildRow(values: (string | number)[]): string {
  return values.map(csvEscape).join(",");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a FOCUS-compliant CSV export from a multi-provider cost comparison.
 *
 * Each row represents one resource in one provider's cost breakdown, giving
 * FinOps tooling a flat, per-line-item view that is compatible with the
 * FinOps Open Cost and Usage Specification (FOCUS).
 *
 * @param comparison - The provider comparison result from CostEngine.
 * @param resources  - The original parsed Terraform resources.
 * @returns A CSV string with FOCUS-compliant column headers.
 */
export function generateFocusReport(
  comparison: ProviderComparison,
  resources: ParsedResource[],
): string {
  const lines: string[] = [];

  // Column header row.
  lines.push(FOCUS_HEADERS.join(","));

  const periodStart = billingPeriodStart();
  const periodEnd = billingPeriodEnd();

  // Build a fast lookup: provider -> resource_id -> CostEstimate.
  const estimateMap = new Map<
    string,
    Map<string, { monthly_cost: number; breakdown: { unit_price: number }[] }>
  >();
  for (const breakdown of comparison.comparisons) {
    const byResource = new Map<
      string,
      { monthly_cost: number; breakdown: { unit_price: number }[] }
    >();
    for (const estimate of breakdown.by_resource) {
      byResource.set(estimate.resource_id, estimate);
    }
    estimateMap.set(breakdown.provider, byResource);
  }

  // One row per resource per provider breakdown.
  for (const breakdown of comparison.comparisons) {
    const provider = breakdown.provider;
    const providerEstimates = estimateMap.get(provider);

    for (const resource of resources) {
      const estimate = providerEstimates?.get(resource.id);
      const monthlyCost = estimate?.monthly_cost ?? 0;

      // Derive unit price from the first breakdown line item when available;
      // fall back to computing it from monthly cost and quantity.
      const pricingQuantity = derivePricingQuantity(resource);
      const firstLineItem = estimate?.breakdown?.[0];
      const listUnitPrice =
        firstLineItem?.unit_price != null
          ? firstLineItem.unit_price
          : pricingQuantity > 0
            ? monthlyCost / pricingQuantity
            : 0;

      const row = [
        "estimated", // BillingAccountId
        periodStart, // BillingPeriodStart
        periodEnd, // BillingPeriodEnd
        "Usage", // ChargeType
        provider, // Provider
        deriveServiceName(resource.type, provider), // ServiceName
        deriveServiceCategory(resource.type), // ServiceCategory
        resource.id, // ResourceId
        resource.name, // ResourceName
        resource.type, // ResourceType
        resource.region, // Region
        derivePricingUnit(resource.type), // PricingUnit
        pricingQuantity, // PricingQuantity
        monthlyCost.toFixed(4), // EffectiveCost
        monthlyCost.toFixed(4), // ListCost
        listUnitPrice.toFixed(6), // ListUnitPrice
        "USD", // Currency
      ];

      lines.push(buildRow(row));
    }
  }

  return lines.join("\n");
}
