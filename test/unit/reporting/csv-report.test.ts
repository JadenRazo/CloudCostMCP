import { describe, it, expect } from "vitest";
import { generateCsvReport } from "../../../src/reporting/csv-report.js";
import type { ProviderComparison } from "../../../src/types/pricing.js";
import {
  makeResource,
  makeEstimate,
  makeBreakdown,
  makeComparison,
} from "../../helpers/factories.js";

// Parse CSV into array of objects, skipping comment lines starting with #.
function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
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

// ---------------------------------------------------------------------------
// CSV header tests
// ---------------------------------------------------------------------------

describe("generateCsvReport — headers", () => {
  it("generates valid CSV output with the expected header columns", () => {
    const csv = generateCsvReport(makeComparison(), [makeResource()]);
    const dataLines = csv.split("\n").filter((l) => !l.startsWith("#"));
    const headerLine = dataLines[0]!;
    expect(headerLine).toBe("Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest");
  });

  it("has exactly 6 columns in the header row", () => {
    const csv = generateCsvReport(makeComparison(), [makeResource()]);
    const dataLines = csv.split("\n").filter((l) => !l.startsWith("#"));
    const headers = dataLines[0]!.split(",");
    expect(headers).toHaveLength(6);
  });

  it("includes a comment header line starting with #", () => {
    const csv = generateCsvReport(makeComparison(), [makeResource()]);
    const firstLine = csv.split("\n")[0]!;
    expect(firstLine.startsWith("#")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resource cost rows
// ---------------------------------------------------------------------------

describe("generateCsvReport — resource rows", () => {
  it("includes all resource costs with correct columns", () => {
    const resources = [
      makeResource({ id: "r1", name: "web-server", type: "aws_instance" }),
      makeResource({ id: "r2", name: "database", type: "aws_db_instance" }),
    ];

    const breakdown = makeBreakdown({
      by_resource: [
        makeEstimate({ resource_id: "r1", monthly_cost: 60.74 }),
        makeEstimate({ resource_id: "r2", resource_type: "aws_db_instance", monthly_cost: 120.0 }),
      ],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });

    const rows = parseCsv(generateCsvReport(comparison, resources));
    expect(rows).toHaveLength(2);
    expect(rows[0]!["Resource"]).toBe("web-server");
    expect(rows[0]!["Type"]).toBe("aws_instance");
    expect(rows[1]!["Resource"]).toBe("database");
    expect(rows[1]!["Type"]).toBe("aws_db_instance");
  });

  it("populates AWS Monthly cost from the aws breakdown", () => {
    const resource = makeResource({ id: "vm-1" });
    const breakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ resource_id: "vm-1", monthly_cost: 75.5 })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });

    const rows = parseCsv(generateCsvReport(comparison, [resource]));
    expect(rows[0]!["AWS Monthly"]).toBe("75.50");
  });

  it("shows 0.00 for providers with no cost data", () => {
    const resource = makeResource({ id: "vm-1" });
    const breakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ resource_id: "vm-1", monthly_cost: 60.74 })],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });

    const rows = parseCsv(generateCsvReport(comparison, [resource]));
    expect(rows[0]!["Azure Monthly"]).toBe("0.00");
    expect(rows[0]!["GCP Monthly"]).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// Multi-provider comparison mode
// ---------------------------------------------------------------------------

describe("generateCsvReport — multiple providers", () => {
  it("handles multiple providers in comparison mode", () => {
    const resource = makeResource({ id: "vm-1", name: "web" });

    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "aws", monthly_cost: 60.74 })],
    });
    const azureBreakdown = makeBreakdown({
      provider: "azure",
      region: "eastus",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "azure", monthly_cost: 55.2 })],
    });
    const gcpBreakdown = makeBreakdown({
      provider: "gcp",
      region: "us-central1",
      by_resource: [makeEstimate({ resource_id: "vm-1", provider: "gcp", monthly_cost: 52.1 })],
    });

    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [awsBreakdown, azureBreakdown, gcpBreakdown],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const rows = parseCsv(generateCsvReport(comparison, [resource]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!["AWS Monthly"]).toBe("60.74");
    expect(rows[0]!["Azure Monthly"]).toBe("55.20");
    expect(rows[0]!["GCP Monthly"]).toBe("52.10");
  });

  it("identifies the cheapest provider", () => {
    const resource = makeResource({ id: "vm-1" });

    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ resource_id: "vm-1", monthly_cost: 60.74 })],
    });
    const gcpBreakdown = makeBreakdown({
      provider: "gcp",
      by_resource: [makeEstimate({ resource_id: "vm-1", monthly_cost: 42.1 })],
    });

    const comparison = makeComparison({ comparisons: [awsBreakdown, gcpBreakdown] });

    const rows = parseCsv(generateCsvReport(comparison, [resource]));
    expect(rows[0]!["Cheapest"]).toBe("GCP");
  });

  it("cheapest is N/A when all provider costs are zero", () => {
    const resource = makeResource({ id: "vm-1" });
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const rows = parseCsv(generateCsvReport(comparison, [resource]));
    expect(rows[0]!["Cheapest"]).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("generateCsvReport — empty input", () => {
  it("handles empty input gracefully with no resources", () => {
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const csv = generateCsvReport(comparison, []);
    const dataLines = csv.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    // Only the header row, no data rows.
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain("Resource");
  });

  it("handles comparisons with breakdowns but no matching resources", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, []);
    const dataLines = csv.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(dataLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CSV field escaping
// ---------------------------------------------------------------------------

describe("generateCsvReport — CSV escaping", () => {
  it("properly escapes commas in resource names", () => {
    const resource = makeResource({ name: "server,primary" });
    const csv = generateCsvReport(makeComparison(), [resource]);
    expect(csv).toContain('"server,primary"');
  });

  it("properly escapes quotes in resource names", () => {
    const resource = makeResource({ name: 'my "best" server' });
    const csv = generateCsvReport(makeComparison(), [resource]);
    expect(csv).toContain('"my ""best"" server"');
  });

  it("properly escapes commas in resource types", () => {
    const resource = makeResource({ type: "aws_instance,spot" });
    const csv = generateCsvReport(makeComparison(), [resource]);
    expect(csv).toContain('"aws_instance,spot"');
  });

  it("does not quote plain fields without special characters", () => {
    const resource = makeResource({ name: "simpleserver" });
    const rows = parseCsv(generateCsvReport(makeComparison(), [resource]));
    expect(rows[0]!["Resource"]).toBe("simpleserver");
  });

  it("escapes fields containing newlines", () => {
    const resource = makeResource({ name: "server\nbackup" });
    const csv = generateCsvReport(makeComparison(), [resource]);
    expect(csv).toContain('"server\nbackup"');
  });
});

// ---------------------------------------------------------------------------
// Tag grouping
// ---------------------------------------------------------------------------

describe("generateCsvReport — tag grouping", () => {
  it("appends Tag Group column when group_by is tag", () => {
    const resource = makeResource({ tags: { env: "production" } });
    const csv = generateCsvReport(makeComparison(), [resource], {
      group_by: "tag",
      group_by_tag_key: "env",
    });
    const dataLines = csv.split("\n").filter((l) => !l.startsWith("#"));
    expect(dataLines[0]).toContain("Tag Group");
    const rows = parseCsv(csv);
    expect(rows[0]!["Tag Group"]).toBe("production");
  });

  it("uses 'Untagged' when tag key is missing from resource", () => {
    const resource = makeResource({ tags: {} });
    const csv = generateCsvReport(makeComparison(), [resource], {
      group_by: "tag",
      group_by_tag_key: "env",
    });
    const rows = parseCsv(csv);
    expect(rows[0]!["Tag Group"]).toBe("Untagged");
  });

  it("does not include Tag Group column when group_by is not tag", () => {
    const csv = generateCsvReport(makeComparison(), [makeResource()]);
    const dataLines = csv.split("\n").filter((l) => !l.startsWith("#"));
    expect(dataLines[0]).not.toContain("Tag Group");
  });
});
