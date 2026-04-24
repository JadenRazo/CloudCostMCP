import { describe, it, expect } from "vitest";
import { generateFocusReport } from "../../../src/reporting/focus-report.js";
import type { ProviderComparison, CostBreakdown } from "../../../src/types/pricing.js";
import { makeResource, makeEstimate, makeBreakdown } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// CSV parsing helper
// ---------------------------------------------------------------------------

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split("\n").filter((l) => l.trim() !== "");
  const headers = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const fields: string[] = [];
    let inQuote = false;
    let current = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === "," && !inQuote) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return Object.fromEntries(headers.map((h, idx) => [h, fields[idx] ?? ""]));
  });
}

/**
 * Build a single-resource, single-provider comparison and return the parsed
 * row with the resource's ServiceName / ServiceCategory / PricingUnit.
 */
function rowFor(opts: {
  provider: "aws" | "azure" | "gcp";
  resourceType: string;
  region?: string;
  monthlyCost?: number;
  unitPrice?: number;
  storageSizeGb?: number;
}): Record<string, string> {
  const { provider, resourceType, region, monthlyCost, unitPrice, storageSizeGb } = opts;
  const resource = makeResource({
    id: "r-1",
    type: resourceType,
    region: region ?? "us-east-1",
    attributes: storageSizeGb ? { storage_size_gb: storageSizeGb } : {},
  });
  const breakdown: CostBreakdown = makeBreakdown({
    provider,
    by_resource: [
      makeEstimate({
        resource_id: "r-1",
        resource_type: resourceType,
        provider,
        monthly_cost: monthlyCost ?? 60.74,
        breakdown:
          unitPrice !== undefined
            ? [
                {
                  description: "x",
                  unit: "x",
                  quantity: 1,
                  unit_price: unitPrice,
                  monthly_cost: monthlyCost ?? 60.74,
                },
              ]
            : [],
      }),
    ],
  });
  const comparison: ProviderComparison = {
    source_provider: provider,
    comparisons: [breakdown],
    savings_summary: [],
    generated_at: new Date().toISOString(),
  };
  const rows = parseCsv(generateFocusReport(comparison, [resource]));
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// deriveServiceName via the report rendering
// ---------------------------------------------------------------------------

describe("generateFocusReport — ServiceName by provider+type", () => {
  // Compute / VM
  it.each([
    ["aws", "aws_instance", "Amazon EC2"],
    ["azure", "azurerm_virtual_machine", "Azure Virtual Machines"],
    ["gcp", "google_compute_instance", "Google Compute Engine"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Kubernetes / containers
  it.each([
    ["aws", "aws_eks_cluster", "Amazon EKS"],
    ["azure", "azurerm_kubernetes_cluster", "Azure Kubernetes Service"],
    ["gcp", "google_container_cluster", "Google Kubernetes Engine"],
    ["gcp", "google_container_node_pool", "Google Kubernetes Engine"],
    ["aws", "aws_eks_node_group", "Amazon EKS"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Databases — note deriveServiceName's check order puts compute ahead of
  // database, so types like "aws_db_instance" fall into the Compute branch.
  // ServiceCategory has the correct order; only ServiceName is affected.
  it.each([
    ["azure", "azurerm_sql_server", "Azure SQL Database"],
    ["aws", "aws_rds_proxy", "Amazon RDS"], // "rds" match without "instance"/"cluster"
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Storage / buckets / disks
  it.each([
    ["aws", "aws_s3_bucket", "Amazon S3"],
    ["azure", "azurerm_storage_account", "Azure Blob Storage"],
    ["gcp", "google_storage_bucket", "Google Cloud Storage"],
    ["aws", "aws_ebs_volume", "Amazon S3"], // ebs matches "ebs"
    ["azure", "azurerm_managed_disk", "Azure Blob Storage"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Load balancer / NAT / gateway — uses substring match on "lb", "nat", etc.
  it.each([
    ["aws", "aws_lb", "Elastic Load Balancing"],
    ["aws", "aws_nat_gateway", "Elastic Load Balancing"],
    ["azure", "azurerm_lb", "Azure Load Balancer"],
    ["gcp", "google_nat_router", "Cloud Load Balancing"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // DNS
  it.each([
    ["aws", "aws_route53_zone", "Amazon Route 53"],
    ["azure", "azurerm_dns_zone", "Azure DNS"],
    ["gcp", "google_dns_managed_zone", "Cloud DNS"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Secrets / KMS / Key Vault
  it.each([
    ["aws", "aws_secretsmanager_secret", "AWS Secrets Manager"],
    ["aws", "aws_kms_key", "AWS Secrets Manager"],
    ["azure", "azurerm_key_vault", "Azure Key Vault"],
    ["gcp", "google_secret_manager_secret", "Secret Manager"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  // Container registry / artifact
  it.each([
    ["aws", "aws_ecr_repository", "Amazon ECR"],
    ["azure", "azurerm_container_registry", "Azure Container Registry"],
    ["gcp", "google_artifact_registry_repository", "Artifact Registry"],
  ] as const)("%s + %s → %s", (provider, type, name) => {
    const row = rowFor({ provider, resourceType: type });
    expect(row["ServiceName"]).toBe(name);
  });

  it("falls back to 'Other' for unrecognised resource types", () => {
    const row = rowFor({ provider: "aws", resourceType: "aws_cloudwatch_metric_alarm" });
    expect(row["ServiceName"]).toBe("Other");
  });
});

// ---------------------------------------------------------------------------
// PricingUnit edge cases & ListUnitPrice computation paths
// ---------------------------------------------------------------------------

describe("generateFocusReport — PricingUnit / ListUnitPrice paths", () => {
  it("non-compute / non-storage resources use 'Units' as PricingUnit and 1 as quantity", () => {
    const row = rowFor({
      provider: "aws",
      resourceType: "aws_cloudwatch_metric_alarm",
    });
    expect(row["PricingUnit"]).toBe("Units");
    expect(row["PricingQuantity"]).toBe("1");
  });

  it("storage resources without storage_size_gb default to PricingQuantity 1", () => {
    const row = rowFor({
      provider: "aws",
      resourceType: "aws_s3_bucket",
      // No storageSizeGb attribute provided.
    });
    expect(row["PricingUnit"]).toBe("GB-Month");
    expect(row["PricingQuantity"]).toBe("1");
  });

  it("storage resources with non-numeric storage_size_gb default to PricingQuantity 1", () => {
    const resource = makeResource({
      id: "blob-1",
      type: "aws_s3_bucket",
      attributes: { storage_size_gb: "not-a-number" as unknown as number },
    });
    const breakdown = makeBreakdown({
      by_resource: [makeEstimate({ resource_id: "blob-1", resource_type: "aws_s3_bucket" })],
    });
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [breakdown],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["PricingQuantity"]).toBe("1");
  });

  it("storage resources with zero storage_size_gb default to PricingQuantity 1", () => {
    const row = rowFor({
      provider: "aws",
      resourceType: "aws_s3_bucket",
      storageSizeGb: 0,
    });
    expect(row["PricingQuantity"]).toBe("1");
  });

  it("ListUnitPrice uses estimate.breakdown[0].unit_price when available", () => {
    const row = rowFor({
      provider: "aws",
      resourceType: "aws_instance",
      monthlyCost: 73,
      unitPrice: 0.1,
    });
    expect(parseFloat(row["ListUnitPrice"]!)).toBeCloseTo(0.1, 6);
  });

  it("ListUnitPrice is computed from monthly_cost / quantity when no breakdown", () => {
    const row = rowFor({
      provider: "aws",
      resourceType: "aws_instance",
      monthlyCost: 73,
      // No unitPrice → no breakdown[0] → derived: 73 / 730 = 0.1
    });
    expect(parseFloat(row["ListUnitPrice"]!)).toBeCloseTo(73 / 730, 4);
  });

  it("ListUnitPrice falls back to 0 when both quantity and breakdown are absent", () => {
    // Build a custom resource with type that yields PricingQuantity 1
    // (non-compute, non-storage), and an estimate without a breakdown.
    const resource = makeResource({ id: "alarm-1", type: "aws_cloudwatch_metric_alarm" });
    const estimate = makeEstimate({
      resource_id: "alarm-1",
      resource_type: "aws_cloudwatch_metric_alarm",
      monthly_cost: 5,
      breakdown: [],
    });
    const breakdown = makeBreakdown({ by_resource: [estimate] });
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [breakdown],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    // 5 / 1 = 5
    expect(parseFloat(rows[0]!["ListUnitPrice"]!)).toBeCloseTo(5, 4);
  });

  it("rows are emitted with monthly_cost=0 and listUnitPrice=0 when estimate is missing", () => {
    // Resource exists in inventory but no estimate for that provider.
    const resource = makeResource({ id: "ghost-1", type: "aws_instance" });
    const breakdown = makeBreakdown({ by_resource: [] });
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [breakdown],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["ResourceId"]).toBe("ghost-1");
    expect(parseFloat(rows[0]!["EffectiveCost"]!)).toBe(0);
    expect(parseFloat(rows[0]!["ListUnitPrice"]!)).toBe(0);
  });
});
