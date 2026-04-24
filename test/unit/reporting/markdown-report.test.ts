import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../../../src/reporting/markdown-report.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { CostEstimate } from "../../../src/types/pricing.js";
import {
  makeResource,
  makeEstimate,
  makeBreakdown,
  makeComparison,
} from "../../helpers/factories.js";

/**
 * Builds a fixture with three resources across two tag groups plus one untagged.
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
      makeBreakdown({ total_monthly: 700, total_yearly: 8400, by_resource: estimates }),
    ],
  });

  return { resources, comparison };
}

// ---------------------------------------------------------------------------
// Limitations section
// ---------------------------------------------------------------------------

describe("generateMarkdownReport — Limitations section", () => {
  it("appears when parse warnings are provided", () => {
    const comparison = makeComparison();
    const parseWarnings = ["module.app not expanded: module block not supported"];
    const report = generateMarkdownReport(comparison, [makeResource()], {}, parseWarnings);
    expect(report).toContain("## Limitations");
    expect(report).toContain("module.app not expanded");
  });

  it("appears when breakdown has data quality warnings", () => {
    const breakdown = makeBreakdown({
      warnings: ["web (aws_instance): using fallback/bundled pricing data"],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).toContain("## Limitations");
    expect(report).toContain("fallback");
  });

  it("is absent when there are no warnings", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).not.toContain("## Limitations");
  });
});

// ---------------------------------------------------------------------------
// Tag grouping
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
// Default behaviour (no tag grouping)
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

  it("does not include Cost by Tag when group_by is not tag", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()], {
      group_by: "service",
    });
    expect(report).not.toContain("## Cost by Tag");
  });
});
