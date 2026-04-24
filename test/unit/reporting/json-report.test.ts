import { describe, it, expect } from "vitest";
import { generateJsonReport } from "../../../src/reporting/json-report.js";
import type { ProviderComparison } from "../../../src/types/pricing.js";
import {
  makeResource,
  makeEstimate,
  makeBreakdown,
  makeComparison,
} from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// Valid JSON output
// ---------------------------------------------------------------------------

describe("generateJsonReport — valid JSON", () => {
  it("generates valid parseable JSON", () => {
    const output = generateJsonReport(makeComparison(), [makeResource()]);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("returns a string", () => {
    const output = generateJsonReport(makeComparison(), [makeResource()]);
    expect(typeof output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Metadata section
// ---------------------------------------------------------------------------

describe("generateJsonReport — metadata", () => {
  it("includes a metadata object with generated_at timestamp", () => {
    const parsed = JSON.parse(generateJsonReport(makeComparison(), [makeResource()]));
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata.generated_at).toBeDefined();
    expect(() => new Date(parsed.metadata.generated_at)).not.toThrow();
  });

  it("includes assumptions with default monthly_hours of 730", () => {
    const parsed = JSON.parse(generateJsonReport(makeComparison(), [makeResource()]));
    expect(parsed.metadata.assumptions.monthly_hours).toBe(730);
    expect(parsed.metadata.assumptions.pricing_model).toBe("on-demand");
    expect(parsed.metadata.assumptions.currency).toBe("USD");
  });

  it("uses custom monthlyHours when provided", () => {
    const parsed = JSON.parse(generateJsonReport(makeComparison(), [makeResource()], 744));
    expect(parsed.metadata.assumptions.monthly_hours).toBe(744);
  });

  it("collects unique pricing sources across all estimates", () => {
    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [
        makeEstimate({ resource_id: "r1", pricing_source: "live" }),
        makeEstimate({ resource_id: "r2", pricing_source: "fallback" }),
      ],
    });
    const comparison = makeComparison({ comparisons: [awsBreakdown] });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.metadata.pricing_sources_used).toContain("aws_live");
    expect(parsed.metadata.pricing_sources_used).toContain("aws_fallback");
  });

  it("pricing sources are sorted alphabetically", () => {
    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [
        makeEstimate({ pricing_source: "live" }),
        makeEstimate({ pricing_source: "fallback" }),
      ],
    });
    const comparison = makeComparison({ comparisons: [awsBreakdown] });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    const sources = parsed.metadata.pricing_sources_used as string[];
    const sorted = [...sources].sort();
    expect(sources).toEqual(sorted);
  });

  it("includes warnings from parse warnings and breakdown warnings", () => {
    const breakdown = makeBreakdown({ warnings: ["pricing data stale"] });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const parsed = JSON.parse(
      generateJsonReport(comparison, [makeResource()], 730, ["missing region"]),
    );
    expect(parsed.metadata.warnings).toContain("missing region");
    expect(parsed.metadata.warnings).toContain("pricing data stale");
  });

  it("deduplicates warnings", () => {
    const breakdown = makeBreakdown({ warnings: ["duplicate warning"] });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const parsed = JSON.parse(
      generateJsonReport(comparison, [makeResource()], 730, ["duplicate warning"]),
    );
    const count = parsed.metadata.warnings.filter((w: string) => w === "duplicate warning").length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Total costs and per-resource breakdowns
// ---------------------------------------------------------------------------

describe("generateJsonReport — cost breakdowns", () => {
  it("includes total costs from comparisons", () => {
    const breakdown = makeBreakdown({ total_monthly: 150.0, total_yearly: 1800.0 });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.comparisons[0].total_monthly).toBe(150.0);
    expect(parsed.comparisons[0].total_yearly).toBe(1800.0);
  });

  it("includes per-resource breakdowns within comparisons", () => {
    const breakdown = makeBreakdown({
      by_resource: [
        makeEstimate({ resource_id: "r1", monthly_cost: 60.74 }),
        makeEstimate({ resource_id: "r2", monthly_cost: 120.0 }),
      ],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.comparisons[0].by_resource).toHaveLength(2);
    expect(parsed.comparisons[0].by_resource[0].resource_id).toBe("r1");
    expect(parsed.comparisons[0].by_resource[1].resource_id).toBe("r2");
  });

  it("includes savings_summary from the comparison", () => {
    const comparison = makeComparison({
      savings_summary: [
        {
          provider: "aws",
          total_monthly: 60.74,
          difference_from_source: 0,
          percentage_difference: 0,
        },
        {
          provider: "gcp",
          total_monthly: 50.0,
          difference_from_source: -10.74,
          percentage_difference: -17.68,
        },
      ],
    });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.savings_summary).toHaveLength(2);
    expect(parsed.savings_summary[1].provider).toBe("gcp");
  });
});

// ---------------------------------------------------------------------------
// Multiple providers
// ---------------------------------------------------------------------------

describe("generateJsonReport — multiple providers", () => {
  it("handles multiple provider breakdowns", () => {
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

    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.comparisons).toHaveLength(3);

    const providers = parsed.comparisons.map((c: { provider: string }) => c.provider);
    expect(providers).toContain("aws");
    expect(providers).toContain("azure");
    expect(providers).toContain("gcp");
  });

  it("collects pricing sources across all providers", () => {
    const awsBreakdown = makeBreakdown({
      provider: "aws",
      by_resource: [makeEstimate({ pricing_source: "live" })],
    });
    const gcpBreakdown = makeBreakdown({
      provider: "gcp",
      by_resource: [makeEstimate({ pricing_source: "bundled" })],
    });
    const comparison = makeComparison({ comparisons: [awsBreakdown, gcpBreakdown] });
    const parsed = JSON.parse(generateJsonReport(comparison, [makeResource()]));
    expect(parsed.metadata.pricing_sources_used).toContain("aws_live");
    expect(parsed.metadata.pricing_sources_used).toContain("gcp_bundled");
  });
});

// ---------------------------------------------------------------------------
// Resource summary
// ---------------------------------------------------------------------------

describe("generateJsonReport — resource summary", () => {
  it("includes resource_summary with total count", () => {
    const resources = [
      makeResource({ id: "r1", type: "aws_instance" }),
      makeResource({ id: "r2", type: "aws_db_instance" }),
      makeResource({ id: "r3", type: "aws_instance" }),
    ];
    const parsed = JSON.parse(generateJsonReport(makeComparison(), resources));
    expect(parsed.resource_summary.total).toBe(3);
  });

  it("includes resource_summary grouped by type", () => {
    const resources = [
      makeResource({ id: "r1", type: "aws_instance" }),
      makeResource({ id: "r2", type: "aws_db_instance" }),
      makeResource({ id: "r3", type: "aws_instance" }),
    ];
    const parsed = JSON.parse(generateJsonReport(makeComparison(), resources));
    expect(parsed.resource_summary.by_type["aws_instance"]).toBe(2);
    expect(parsed.resource_summary.by_type["aws_db_instance"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("generateJsonReport — empty input", () => {
  it("handles empty comparisons and resources", () => {
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const output = generateJsonReport(comparison, []);
    expect(() => JSON.parse(output)).not.toThrow();

    const parsed = JSON.parse(output);
    expect(parsed.comparisons).toEqual([]);
    expect(parsed.resource_summary.total).toBe(0);
    expect(parsed.resource_summary.by_type).toEqual({});
  });

  it("has empty pricing sources when there are no estimates", () => {
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const parsed = JSON.parse(generateJsonReport(comparison, []));
    expect(parsed.metadata.pricing_sources_used).toEqual([]);
  });

  it("has empty warnings when no warnings are provided", () => {
    const comparison: ProviderComparison = {
      source_provider: "aws",
      comparisons: [],
      savings_summary: [],
      generated_at: new Date().toISOString(),
    };

    const parsed = JSON.parse(generateJsonReport(comparison, []));
    expect(parsed.metadata.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tag grouping
// ---------------------------------------------------------------------------

describe("generateJsonReport — tag grouping", () => {
  it("includes cost_by_tag when group_by is tag", () => {
    const resources = [
      makeResource({ id: "r1", tags: { env: "prod" } }),
      makeResource({ id: "r2", tags: { env: "dev" } }),
      makeResource({ id: "r3", tags: { env: "prod" } }),
    ];
    const breakdown = makeBreakdown({
      by_resource: [
        makeEstimate({ resource_id: "r1", monthly_cost: 60.0 }),
        makeEstimate({ resource_id: "r2", monthly_cost: 30.0 }),
        makeEstimate({ resource_id: "r3", monthly_cost: 40.0 }),
      ],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });

    const parsed = JSON.parse(
      generateJsonReport(comparison, resources, 730, [], {
        group_by: "tag",
        group_by_tag_key: "env",
      }),
    );

    expect(parsed.cost_by_tag).toBeDefined();
    expect(parsed.cost_by_tag.tag_key).toBe("env");
    expect(parsed.cost_by_tag.groups.prod.resource_count).toBe(2);
    expect(parsed.cost_by_tag.groups.prod.monthly_cost).toBe(100.0);
    expect(parsed.cost_by_tag.groups.dev.resource_count).toBe(1);
    expect(parsed.cost_by_tag.groups.dev.monthly_cost).toBe(30.0);
  });

  it("uses Untagged for resources missing the tag key", () => {
    const resources = [makeResource({ id: "r1", tags: {} })];
    const comparison = makeComparison();

    const parsed = JSON.parse(
      generateJsonReport(comparison, resources, 730, [], {
        group_by: "tag",
        group_by_tag_key: "env",
      }),
    );

    expect(parsed.cost_by_tag.groups["Untagged"]).toBeDefined();
    expect(parsed.cost_by_tag.groups["Untagged"].resource_count).toBe(1);
  });

  it("does not include cost_by_tag when group_by is not tag", () => {
    const parsed = JSON.parse(generateJsonReport(makeComparison(), [makeResource()]));
    expect(parsed.cost_by_tag).toBeUndefined();
  });
});
