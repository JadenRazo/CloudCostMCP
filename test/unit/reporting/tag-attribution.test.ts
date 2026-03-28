import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../../../src/reporting/markdown-report.js";
import { generateJsonReport } from "../../../src/reporting/json-report.js";
import { generateCsvReport } from "../../../src/reporting/csv-report.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type {
  ProviderComparison,
  CostBreakdown,
  CostEstimate,
} from "../../../src/types/pricing.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<ParsedResource> = {}): ParsedResource {
  return {
    id: "res-1",
    type: "aws_instance",
    name: "web-server",
    provider: "aws",
    region: "us-east-1",
    attributes: { instance_type: "t3.medium" },
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    resource_id: "res-1",
    resource_type: "aws_instance",
    resource_name: "web-server",
    provider: "aws",
    region: "us-east-1",
    monthly_cost: 100,
    yearly_cost: 1200,
    currency: "USD",
    breakdown: [],
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
    total_monthly: 100,
    total_yearly: 1200,
    currency: "USD",
    by_service: { compute: 100 },
    by_resource: [makeEstimate()],
    generated_at: new Date().toISOString(),
    warnings: [],
    ...overrides,
  };
}

function makeComparison(overrides: Partial<ProviderComparison> = {}): ProviderComparison {
  return {
    source_provider: "aws",
    comparisons: [makeBreakdown()],
    savings_summary: [
      { provider: "aws", total_monthly: 100, difference_from_source: 0, percentage_difference: 0 },
    ],
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Builds a realistic fixture with three resources across two tag groups plus
 * one untagged resource.
 *
 * Resources:
 *   - backend-api   (team=backend)  $150/month
 *   - backend-db    (team=backend)  $300/month
 *   - frontend-web  (team=frontend) $200/month
 *   - orphan        (no team tag)   $50/month
 */
function makeTaggedFixture() {
  const resources: ParsedResource[] = [
    makeResource({ id: "r-be-api", name: "backend-api", tags: { team: "backend" } }),
    makeResource({ id: "r-be-db", name: "backend-db", tags: { team: "backend" } }),
    makeResource({ id: "r-fe-web", name: "frontend-web", tags: { team: "frontend" } }),
    makeResource({ id: "r-orphan", name: "orphan", tags: {} }),
  ];

  const estimates: CostEstimate[] = [
    makeEstimate({
      resource_id: "r-be-api",
      resource_name: "backend-api",
      monthly_cost: 150,
      yearly_cost: 1800,
    }),
    makeEstimate({
      resource_id: "r-be-db",
      resource_name: "backend-db",
      monthly_cost: 300,
      yearly_cost: 3600,
    }),
    makeEstimate({
      resource_id: "r-fe-web",
      resource_name: "frontend-web",
      monthly_cost: 200,
      yearly_cost: 2400,
    }),
    makeEstimate({
      resource_id: "r-orphan",
      resource_name: "orphan",
      monthly_cost: 50,
      yearly_cost: 600,
    }),
  ];

  const comparison = makeComparison({
    comparisons: [
      makeBreakdown({
        total_monthly: 700,
        total_yearly: 8400,
        by_resource: estimates,
      }),
    ],
  });

  return { resources, comparison };
}

// ---------------------------------------------------------------------------
// Markdown — tag grouping
// ---------------------------------------------------------------------------

describe("generateMarkdownReport — tag grouping", () => {
  it("includes a Cost by Tag section when group_by=tag is set", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(report).toContain("## Cost by Tag");
  });

  it("shows the tag key in the Cost by Tag section", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(report).toContain("`team`");
  });

  it("lists each tag value in the summary table", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(report).toContain("backend");
    expect(report).toContain("frontend");
  });

  it("includes an Untagged row for resources missing the tag", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(report).toContain("Untagged");
  });

  it("shows correct resource counts in the Cost by Tag table", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    // backend has 2 resources, frontend has 1, Untagged has 1
    // Each cell in the tag summary table has its own column
    expect(report).toContain("| backend | 2 |");
    expect(report).toContain("| frontend | 1 |");
    expect(report).toContain("| Untagged | 1 |");
  });

  it("places Cost by Tag section before Resource Breakdown", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const tagIdx = report.indexOf("## Cost by Tag");
    const breakdownIdx = report.indexOf("## Resource Breakdown");
    expect(tagIdx).toBeGreaterThanOrEqual(0);
    expect(breakdownIdx).toBeGreaterThan(tagIdx);
  });

  it("organises the Resource Breakdown under tag group headings", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(report).toContain("### backend");
    expect(report).toContain("### frontend");
    expect(report).toContain("### Untagged");
  });

  it("each resource appears under the correct group heading", () => {
    const { comparison, resources } = makeTaggedFixture();
    const report = generateMarkdownReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });

    const backendIdx = report.indexOf("### backend");
    const frontendIdx = report.indexOf("### frontend");
    const beApiIdx = report.indexOf("backend-api");
    const feWebIdx = report.indexOf("frontend-web");

    expect(beApiIdx).toBeGreaterThan(backendIdx);
    expect(feWebIdx).toBeGreaterThan(frontendIdx);
  });
});

// ---------------------------------------------------------------------------
// Markdown — default behaviour unchanged when group_by is not "tag"
// ---------------------------------------------------------------------------

describe("generateMarkdownReport — default behaviour (no grouping)", () => {
  it("does not include a Cost by Tag section by default", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).not.toContain("## Cost by Tag");
  });

  it("still renders the Resource Breakdown section normally", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).toContain("## Resource Breakdown");
  });

  it("does not include Cost by Tag when group_by is not set", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()], {
      group_by: "service",
    });
    expect(report).not.toContain("## Cost by Tag");
  });
});

// ---------------------------------------------------------------------------
// JSON — tag grouping
// ---------------------------------------------------------------------------

describe("generateJsonReport — tag grouping", () => {
  it("includes cost_by_tag when group_by=tag is set", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag).toBeDefined();
  });

  it("cost_by_tag contains the tag_key", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag.tag_key).toBe("team");
  });

  it("cost_by_tag.groups contains each tag value", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag.groups.backend).toBeDefined();
    expect(parsed.cost_by_tag.groups.frontend).toBeDefined();
    expect(parsed.cost_by_tag.groups.Untagged).toBeDefined();
  });

  it("cost_by_tag.groups has correct resource_count values", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag.groups.backend.resource_count).toBe(2);
    expect(parsed.cost_by_tag.groups.frontend.resource_count).toBe(1);
    expect(parsed.cost_by_tag.groups.Untagged.resource_count).toBe(1);
  });

  it("cost_by_tag.groups has correct monthly_cost values", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag.groups.backend.monthly_cost).toBe(450);
    expect(parsed.cost_by_tag.groups.frontend.monthly_cost).toBe(200);
    expect(parsed.cost_by_tag.groups.Untagged.monthly_cost).toBe(50);
  });

  it("Untagged group represents resources missing the tag key", () => {
    const { comparison, resources } = makeTaggedFixture();
    const raw = generateJsonReport(comparison, resources, 730, [], {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag.groups.Untagged.resource_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JSON — default behaviour unchanged when group_by is not "tag"
// ---------------------------------------------------------------------------

describe("generateJsonReport — default behaviour (no grouping)", () => {
  it("does not include cost_by_tag when options are not provided", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag).toBeUndefined();
  });

  it("does not include cost_by_tag when group_by is a different value", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()], 730, [], {
      group_by: "resource",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.cost_by_tag).toBeUndefined();
  });

  it("metadata is still present when options omit tag grouping", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(parsed.metadata).toBeDefined();
    expect(parsed.resource_summary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CSV — tag grouping
// ---------------------------------------------------------------------------

describe("generateCsvReport — tag grouping", () => {
  it("adds a Tag Group column header when group_by=tag is set", () => {
    const { comparison, resources } = makeTaggedFixture();
    const csv = generateCsvReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(csv).toContain("Tag Group");
  });

  it("each data row has a tag_group value", () => {
    const { comparison, resources } = makeTaggedFixture();
    const csv = generateCsvReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    const dataLines = csv
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.includes(",") && !l.startsWith("Resource"));
    expect(dataLines.length).toBe(resources.length);
    // Every data row should end with a tag group value.
    for (const line of dataLines) {
      const cols = line.split(",");
      expect(cols.length).toBe(7); // Resource,Type,AWS,Azure,GCP,Cheapest,Tag Group
    }
  });

  it("tag group column reflects the correct tag value for each resource", () => {
    const { comparison, resources } = makeTaggedFixture();
    const csv = generateCsvReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(csv).toContain("backend");
    expect(csv).toContain("frontend");
  });

  it("resources without the tag key get Untagged in the tag_group column", () => {
    const { comparison, resources } = makeTaggedFixture();
    const csv = generateCsvReport(comparison, resources, {
      group_by: "tag",
      group_by_tag_key: "team",
    });
    expect(csv).toContain("Untagged");
  });
});

// ---------------------------------------------------------------------------
// CSV — default behaviour unchanged when group_by is not "tag"
// ---------------------------------------------------------------------------

describe("generateCsvReport — default behaviour (no grouping)", () => {
  it("does not include a Tag Group column by default", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    expect(csv).not.toContain("Tag Group");
    expect(csv).toContain("Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest");
  });

  it("data rows have 6 columns when tag grouping is inactive", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    const dataLine = csv
      .split("\n")
      .find((l) => !l.startsWith("#") && !l.startsWith("Resource") && l.includes(","));
    expect(dataLine).toBeDefined();
    expect(dataLine!.split(",").length).toBe(6);
  });

  it("comment header and column header are still present without options", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    const lines = csv.split("\n");
    expect(lines[0].startsWith("#")).toBe(true);
    expect(lines[1]).toContain("Resource");
  });
});
