import { describe, it, expect } from "vitest";
import { generateFocusReport, deriveServiceCategory } from "../../../src/reporting/focus-report.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { ProviderComparison, CostBreakdown, CostEstimate } from "../../../src/types/pricing.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<ParsedResource> = {}): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_instance",
    name: "test-instance",
    provider: "aws",
    region: "us-east-1",
    attributes: { instance_type: "t3.large" },
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    resource_id: "test-resource",
    resource_type: "aws_instance",
    resource_name: "test-instance",
    provider: "aws",
    region: "us-east-1",
    monthly_cost: 60.74,
    yearly_cost: 728.88,
    currency: "USD",
    breakdown: [{ description: "Compute", unit: "Hrs", quantity: 730, unit_price: 0.0832, monthly_cost: 60.74 }],
    confidence: "high",
    notes: [],
    pricing_source: "fallback",
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    provider: "aws",
    region: "us-east-1",
    total_monthly: 60.74,
    total_yearly: 728.88,
    currency: "USD",
    by_service: { compute: 60.74 },
    by_resource: [makeEstimate()],
    generated_at: new Date().toISOString(),
    warnings: [],
    ...overrides,
  };
}

function makeComparison(overrides: Partial<ProviderComparison> = {}): ProviderComparison {
  const breakdown = makeBreakdown();
  return {
    source_provider: "aws",
    comparisons: [breakdown],
    savings_summary: [
      {
        provider: "aws",
        total_monthly: 60.74,
        difference_from_source: 0,
        percentage_difference: 0,
      },
    ],
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Parse the CSV into an array of objects keyed by header name.
function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split("\n").filter((l) => l.trim() !== "");
  const headers = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    // Basic CSV field parser that handles double-quoted fields.
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

// ---------------------------------------------------------------------------
// FOCUS column header tests
// ---------------------------------------------------------------------------

describe("generateFocusReport — column headers", () => {
  it("output starts with the FOCUS column header row", () => {
    const csv = generateFocusReport(makeComparison(), [makeResource()]);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe(
      "BillingAccountId,BillingPeriodStart,BillingPeriodEnd,ChargeType,Provider,ServiceName,ServiceCategory,ResourceId,ResourceName,ResourceType,Region,PricingUnit,PricingQuantity,EffectiveCost,ListCost,ListUnitPrice,Currency"
    );
  });

  it("all 17 FOCUS columns are present", () => {
    const csv = generateFocusReport(makeComparison(), [makeResource()]);
    const headers = csv.split("\n")[0]!.split(",");
    expect(headers).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------
// Row generation tests
// ---------------------------------------------------------------------------

describe("generateFocusReport — row generation", () => {
  it("generates one row per resource per provider", () => {
    const resources = [
      makeResource({ id: "r1", name: "web" }),
      makeResource({ id: "r2", name: "db", type: "aws_db_instance" }),
    ];

    const breakdown = makeBreakdown({
      by_resource: [
        makeEstimate({ resource_id: "r1" }),
        makeEstimate({ resource_id: "r2", resource_type: "aws_db_instance" }),
      ],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });

    const rows = parseCsv(generateFocusReport(comparison, resources));
    // 1 provider × 2 resources = 2 data rows.
    expect(rows).toHaveLength(2);
  });

  it("generates rows for each provider in a multi-provider comparison", () => {
    const resource = makeResource({ id: "vm-1" });

    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "aws", monthly_cost: 60.74 })],
    });
    const azureBreakdown = makeBreakdown({
      provider: "azure",
      region: "eastus",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "azure", monthly_cost: 55.20 })],
    });
    const gcpBreakdown = makeBreakdown({
      provider: "gcp",
      region: "us-central1",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "gcp", monthly_cost: 52.10 })],
    });

    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [awsBreakdown, azureBreakdown, gcpBreakdown],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    // 3 providers × 1 resource = 3 data rows.
    expect(rows).toHaveLength(3);

    const providers = rows.map((r) => r["Provider"]);
    expect(providers).toContain("aws");
    expect(providers).toContain("azure");
    expect(providers).toContain("gcp");
  });

  it("resource fields are correctly mapped to row columns", () => {
    const resource = makeResource({
      id: "my-id",
      name: "my-server",
      type: "aws_instance",
      region: "eu-west-1",
    });

    const rows = parseCsv(generateFocusReport(makeComparison({ comparisons: [makeBreakdown({ by_resource: [makeEstimate({ resource_id: "my-id" })] })] }), [resource]));
    const row = rows[0]!;

    expect(row["ResourceId"]).toBe("my-id");
    expect(row["ResourceName"]).toBe("my-server");
    expect(row["ResourceType"]).toBe("aws_instance");
    expect(row["Region"]).toBe("eu-west-1");
  });

  it("BillingAccountId is always 'estimated'", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    expect(rows[0]!["BillingAccountId"]).toBe("estimated");
  });

  it("ChargeType is always 'Usage'", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    expect(rows[0]!["ChargeType"]).toBe("Usage");
  });

  it("Currency is always 'USD'", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    expect(rows[0]!["Currency"]).toBe("USD");
  });

  it("EffectiveCost and ListCost reflect the estimate monthly_cost", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    const row = rows[0]!;
    expect(parseFloat(row["EffectiveCost"]!)).toBeCloseTo(60.74, 2);
    expect(parseFloat(row["ListCost"]!)).toBeCloseTo(60.74, 2);
  });
});

// ---------------------------------------------------------------------------
// Empty comparison
// ---------------------------------------------------------------------------

describe("generateFocusReport — empty comparison", () => {
  it("produces header-only output when there are no provider comparisons", () => {
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const csv = generateFocusReport(comparison, []);
    const lines = csv.split("\n").filter((l) => l.trim() !== "");
    // Only the header row.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("BillingAccountId");
  });

  it("produces header-only output when comparison has breakdowns but no resources", () => {
    const comparison = makeComparison({ comparisons: [makeBreakdown({ by_resource: [] })] });
    const csv = generateFocusReport(comparison, []);
    const lines = csv.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CSV escaping
// ---------------------------------------------------------------------------

describe("generateFocusReport — CSV escaping", () => {
  it("resource names containing commas are quoted", () => {
    const resource = makeResource({ name: "server,primary" });
    const csv = generateFocusReport(makeComparison(), [resource]);
    expect(csv).toContain('"server,primary"');
  });

  it("resource types containing commas are quoted", () => {
    const resource = makeResource({ type: "aws_instance,spot" });
    const csv = generateFocusReport(makeComparison(), [resource]);
    expect(csv).toContain('"aws_instance,spot"');
  });

  it("embedded double-quotes in field values are escaped", () => {
    const resource = makeResource({ name: 'server"main"' });
    const csv = generateFocusReport(makeComparison(), [resource]);
    // The value should be wrapped in quotes with internal quotes doubled.
    expect(csv).toContain('"server""main"""');
  });

  it("plain fields with no special characters are not quoted", () => {
    const resource = makeResource({ name: "simpleserver", id: "simple-id" });
    const rows = parseCsv(generateFocusReport(makeComparison(), [resource]));
    expect(rows[0]!["ResourceName"]).toBe("simpleserver");
  });
});

// ---------------------------------------------------------------------------
// Service category mapping
// ---------------------------------------------------------------------------

describe("deriveServiceCategory", () => {
  const cases: [string, string][] = [
    ["aws_instance", "Compute"],
    ["azurerm_virtual_machine", "Compute"],
    ["google_compute_instance", "Compute"],
    ["aws_eks_cluster", "Compute"],
    ["azurerm_kubernetes_cluster", "Compute"],
    ["aws_db_instance", "Database"],
    ["azurerm_sql_server", "Database"],
    ["google_sql_database_instance", "Database"],
    ["aws_elasticache_cluster", "Database"],
    ["aws_s3_bucket", "Storage"],
    ["azurerm_storage_account", "Storage"],
    ["google_storage_bucket", "Storage"],
    ["aws_ebs_volume", "Storage"],
    ["aws_lb", "Network"],
    ["aws_nat_gateway", "Network"],
    ["azurerm_dns_zone", "Network"],
    ["aws_secretsmanager_secret", "Security"],
    ["aws_kms_key", "Security"],
    ["azurerm_key_vault", "Security"],
    ["aws_ecr_repository", "Developer Tools"],
    ["aws_lambda_function", "Developer Tools"],
    ["aws_cloudwatch_metric_alarm", "Other"],
  ];

  it.each(cases)("%s maps to %s", (resourceType, expectedCategory) => {
    expect(deriveServiceCategory(resourceType)).toBe(expectedCategory);
  });
});

// ---------------------------------------------------------------------------
// ServiceCategory appears in report rows
// ---------------------------------------------------------------------------

describe("generateFocusReport — ServiceCategory in rows", () => {
  it("compute resource has ServiceCategory Compute", () => {
    const resource = makeResource({ type: "aws_instance" });
    const rows = parseCsv(generateFocusReport(makeComparison(), [resource]));
    expect(rows[0]!["ServiceCategory"]).toBe("Compute");
  });

  it("storage resource has ServiceCategory Storage", () => {
    const resource = makeResource({ type: "aws_s3_bucket", id: "bucket-1" });
    const breakdown = makeBreakdown({
      by_resource: [makeEstimate({ resource_id: "bucket-1", resource_type: "aws_s3_bucket" })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["ServiceCategory"]).toBe("Storage");
  });

  it("database resource has ServiceCategory Database", () => {
    const resource = makeResource({ type: "aws_db_instance", id: "db-1" });
    const breakdown = makeBreakdown({
      by_resource: [makeEstimate({ resource_id: "db-1", resource_type: "aws_db_instance" })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["ServiceCategory"]).toBe("Database");
  });
});

// ---------------------------------------------------------------------------
// PricingUnit mapping
// ---------------------------------------------------------------------------

describe("generateFocusReport — PricingUnit", () => {
  it("compute resources use Hours as PricingUnit", () => {
    const resource = makeResource({ type: "aws_instance" });
    const rows = parseCsv(generateFocusReport(makeComparison(), [resource]));
    expect(rows[0]!["PricingUnit"]).toBe("Hours");
  });

  it("compute resources use 730 as PricingQuantity", () => {
    const resource = makeResource({ type: "aws_instance" });
    const rows = parseCsv(generateFocusReport(makeComparison(), [resource]));
    expect(rows[0]!["PricingQuantity"]).toBe("730");
  });

  it("storage resources use GB-Month as PricingUnit", () => {
    const resource = makeResource({ type: "aws_s3_bucket", id: "b-1", attributes: { storage_size_gb: 100 } });
    const breakdown = makeBreakdown({
      by_resource: [makeEstimate({ resource_id: "b-1" })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["PricingUnit"]).toBe("GB-Month");
  });

  it("storage PricingQuantity reflects storage_size_gb attribute", () => {
    const resource = makeResource({ type: "aws_s3_bucket", id: "b-2", attributes: { storage_size_gb: 500 } });
    const breakdown = makeBreakdown({
      by_resource: [makeEstimate({ resource_id: "b-2" })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const rows = parseCsv(generateFocusReport(comparison, [resource]));
    expect(rows[0]!["PricingQuantity"]).toBe("500");
  });
});

// ---------------------------------------------------------------------------
// Billing period validity
// ---------------------------------------------------------------------------

describe("generateFocusReport — billing period", () => {
  it("BillingPeriodStart is a valid date string", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    const start = rows[0]!["BillingPeriodStart"]!;
    expect(() => new Date(start)).not.toThrow();
    expect(new Date(start).toString()).not.toBe("Invalid Date");
  });

  it("BillingPeriodEnd is a valid date string", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    const end = rows[0]!["BillingPeriodEnd"]!;
    expect(() => new Date(end)).not.toThrow();
    expect(new Date(end).toString()).not.toBe("Invalid Date");
  });

  it("BillingPeriodEnd is after BillingPeriodStart", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    const start = new Date(rows[0]!["BillingPeriodStart"]!).getTime();
    const end = new Date(rows[0]!["BillingPeriodEnd"]!).getTime();
    expect(end).toBeGreaterThan(start);
  });

  it("BillingPeriodStart is the first day of the current month", () => {
    const rows = parseCsv(generateFocusReport(makeComparison(), [makeResource()]));
    const start = new Date(rows[0]!["BillingPeriodStart"]!);
    expect(start.getDate()).toBe(1);
  });
});
