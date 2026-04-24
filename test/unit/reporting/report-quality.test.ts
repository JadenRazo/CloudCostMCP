import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { makeResource, tempDbPath } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// CostBreakdown warnings
// ---------------------------------------------------------------------------

describe("CostBreakdown warnings", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;
  let engine: CostEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-report-quality");
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

// NOTE: Markdown Limitations, JSON metadata, and CSV comment header tests
// have been moved to their dedicated report test files:
// - markdown-report.test.ts
// - json-report.test.ts
// - csv-report.test.ts
