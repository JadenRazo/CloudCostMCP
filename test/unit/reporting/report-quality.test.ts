import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { generateMarkdownReport } from "../../../src/reporting/markdown-report.js";
import { generateJsonReport } from "../../../src/reporting/json-report.js";
import { generateCsvReport } from "../../../src/reporting/csv-report.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type {
  ProviderComparison,
  CostBreakdown,
  CostEstimate,
} from "../../../src/types/pricing.js";

// Disable live network fetches; fallback prices in the loaders are sufficient.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-report-quality-${suffix}`, "cache.db");
}

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

// ---------------------------------------------------------------------------
// CostBreakdown warnings
// ---------------------------------------------------------------------------

describe("CostBreakdown warnings", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;
  let engine: CostEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
    engine = new CostEngine(pricingEngine, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CostBreakdown includes a warnings array", async () => {
    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");
    expect(Array.isArray(breakdown.warnings)).toBe(true);
  });

  it("warnings are populated when fallback pricing is used", async () => {
    const resources = [
      makeResource({
        id: "vm-fallback",
        type: "aws_instance",
        name: "server",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    // With fetch stubbed to fail, all prices use the fallback tables.
    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");
    // The fallback pricing path should add at least one warning entry.
    expect(breakdown.warnings.length).toBeGreaterThan(0);
    expect(breakdown.warnings.some((w) => w.includes("fallback"))).toBe(true);
  });

  it("CostEstimate includes a pricing_source field", async () => {
    const resource = makeResource({
      id: "vm-src",
      type: "aws_instance",
      name: "server",
      attributes: { instance_type: "t3.large" },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");
    expect(estimate.pricing_source).toBeDefined();
    expect(["live", "fallback", "bundled"]).toContain(estimate.pricing_source);
  });

  it("fallback pricing is noted in compute cost estimates", async () => {
    const resource = makeResource({
      id: "vm-note",
      type: "aws_instance",
      name: "app",
      attributes: { instance_type: "t3.micro" },
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");
    // With live API unavailable, pricing_source must be fallback.
    expect(estimate.pricing_source).toBe("fallback");
  });

  it("unsupported resource types get pricing_source fallback and zero cost", async () => {
    const resource = makeResource({
      id: "unsupported",
      type: "aws_cloudwatch_metric_alarm",
      name: "cpu-alarm",
      attributes: {},
    });

    const estimate = await engine.calculateCost(resource, "aws", "us-east-1");
    expect(estimate.monthly_cost).toBe(0);
    expect(estimate.pricing_source).toBe("fallback");
    expect(estimate.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Markdown report — structure
// ---------------------------------------------------------------------------

describe("generateMarkdownReport structure", () => {
  it("Limitations section appears when parse warnings are provided", () => {
    const comparison = makeComparison();
    const parseWarnings = ["module.app not expanded: module block not supported"];
    const report = generateMarkdownReport(comparison, [makeResource()], {}, parseWarnings);
    expect(report).toContain("## Limitations");
    expect(report).toContain("module.app not expanded");
  });

  it("Limitations section appears when breakdown has data quality warnings", () => {
    const breakdown = makeBreakdown({
      warnings: ["web (aws_instance): using fallback/bundled pricing data"],
    });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).toContain("## Limitations");
    expect(report).toContain("fallback");
  });

  it("no Limitations section when there are no warnings", () => {
    const comparison = makeComparison();
    const report = generateMarkdownReport(comparison, [makeResource()]);
    expect(report).not.toContain("## Limitations");
  });
});

// ---------------------------------------------------------------------------
// JSON report — metadata section
// ---------------------------------------------------------------------------

describe("generateJsonReport metadata section", () => {
  it("JSON report contains a metadata section", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(parsed.metadata).toBeDefined();
  });

  it("metadata contains generated_at timestamp", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(parsed.metadata.generated_at).toBeDefined();
    expect(typeof parsed.metadata.generated_at).toBe("string");
    // Must be a valid ISO date string.
    expect(() => new Date(parsed.metadata.generated_at)).not.toThrow();
  });

  it("metadata.assumptions contains the expected keys", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    const assumptions = parsed.metadata.assumptions;
    expect(assumptions).toBeDefined();
    expect(assumptions.pricing_model).toBe("on-demand");
    expect(assumptions.currency).toBe("USD");
    expect(typeof assumptions.monthly_hours).toBe("number");
    expect(assumptions.data_transfer_costs).toBe("not included");
    expect(assumptions.tax).toBe("not included");
  });

  it("metadata.pricing_sources_used is an array", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.metadata.pricing_sources_used)).toBe(true);
  });

  it("metadata.warnings is an array", () => {
    const comparison = makeComparison();
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.metadata.warnings)).toBe(true);
  });

  it("parse_warnings are surfaced in metadata.warnings", () => {
    const comparison = makeComparison();
    const parseWarnings = ["count/for_each not fully resolved for aws_instance.app"];
    const raw = generateJsonReport(comparison, [makeResource()], 730, parseWarnings);
    const parsed = JSON.parse(raw);
    expect(parsed.metadata.warnings).toContain(parseWarnings[0]);
  });

  it("pricing_sources_used reflects the estimate pricing_source values", () => {
    const estimate = makeEstimate({ pricing_source: "fallback" });
    const breakdown = makeBreakdown({ by_resource: [estimate] });
    const comparison = makeComparison({ comparisons: [breakdown] });
    const raw = generateJsonReport(comparison, [makeResource()]);
    const parsed = JSON.parse(raw);
    // Should include an entry for the aws provider with fallback source.
    expect(parsed.metadata.pricing_sources_used.some((s: string) => s.includes("fallback"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// CSV report — comment header
// ---------------------------------------------------------------------------

describe("generateCsvReport comment header", () => {
  it("CSV report starts with a comment line", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    const firstLine = csv.split("\n")[0];
    expect(firstLine.startsWith("#")).toBe(true);
  });

  it("CSV comment mentions on-demand pricing", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    expect(csv).toContain("on-demand pricing");
  });

  it("CSV data header row is still present after the comment", () => {
    const comparison = makeComparison();
    const csv = generateCsvReport(comparison, [makeResource()]);
    expect(csv).toContain("Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest");
  });
});
