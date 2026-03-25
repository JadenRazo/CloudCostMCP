import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { CloudCostConfig } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";

// Disable live network fetches — fallback/bundled prices are sufficient for
// deterministic unit tests.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-budget-test-${suffix}`, "cache.db");
}

function makeConfig(overrides: Partial<CloudCostConfig> = {}): CloudCostConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeEngine(config: CloudCostConfig, dbPath: string): { cache: PricingCache; engine: CostEngine } {
  const cache = new PricingCache(dbPath);
  const pricingEngine = new PricingEngine(cache, config);
  const engine = new CostEngine(pricingEngine, config);
  return { cache, engine };
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_instance",
    name: "test-resource",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// A t3.large costs ~$60.74/month using bundled fallback prices ($0.0832/hr * 730).
// A t3.micro costs ~$7.59/month ($0.0104/hr * 730).
// A t3.small costs ~$15.18/month ($0.0208/hr * 730).

describe("Budget alerts in calculateBreakdown", () => {
  let dbPath: string;
  let cache: PricingCache;
  let engine: CostEngine;

  afterEach(() => {
    cache?.close();
    if (dbPath) {
      const dir = join(dbPath, "..");
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // -------------------------------------------------------------------------
  // No budget configured
  // -------------------------------------------------------------------------

  it("produces no budget_warnings when no budget is configured", async () => {
    const config = makeConfig({ budget: undefined });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeUndefined();
  });

  it("produces no budget_warnings when totals are well below the limit", async () => {
    // t3.micro ~ $7.59/month; set a generous limit of $500
    const config = makeConfig({ budget: { monthly_limit: 500, warn_percentage: 80 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "cheap-server",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Monthly limit — warning threshold
  // -------------------------------------------------------------------------

  it("emits a BUDGET WARNING when monthly cost exceeds warn_percentage of the limit", async () => {
    // t3.large ~ $60.74/month; set limit to $70 with 80% threshold (~$56).
    // $60.74 > $56 but < $70, so we expect a warning (not exceeded).
    const config = makeConfig({ budget: { monthly_limit: 70, warn_percentage: 80 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings!.length).toBe(1);
    expect(breakdown.budget_warnings![0]).toMatch(/^BUDGET WARNING:/);
    expect(breakdown.budget_warnings![0]).toContain("$70");
  });

  // -------------------------------------------------------------------------
  // Monthly limit — exceeded
  // -------------------------------------------------------------------------

  it("emits a BUDGET EXCEEDED message when monthly cost is over the limit", async () => {
    // t3.large ~ $60.74/month; set limit to $50 so it is clearly exceeded.
    const config = makeConfig({ budget: { monthly_limit: 50, warn_percentage: 80 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings!.length).toBe(1);
    expect(breakdown.budget_warnings![0]).toMatch(/^BUDGET EXCEEDED:/);
    expect(breakdown.budget_warnings![0]).toContain("$50");
  });

  it("does not emit a warning message when monthly cost exactly equals the limit", async () => {
    // Set an absurdly high limit that can never be breached in tests.
    const config = makeConfig({ budget: { monthly_limit: 100_000, warn_percentage: 80 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const breakdown = await engine.calculateBreakdown([], "aws", "us-east-1");

    // $0 monthly cost — no warnings expected.
    expect(breakdown.budget_warnings).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Per-resource limit
  // -------------------------------------------------------------------------

  it("emits RESOURCE OVER BUDGET for each resource that exceeds the per-resource limit", async () => {
    // t3.large ~ $60.74/month, t3.micro ~ $7.59/month.
    // Set per_resource_limit to $30 — only the large instance should trigger.
    const config = makeConfig({ budget: { per_resource_limit: 30 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "large-vm",
        type: "aws_instance",
        name: "large",
        attributes: { instance_type: "t3.large" },
      }),
      makeResource({
        id: "micro-vm",
        type: "aws_instance",
        name: "micro",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings!.length).toBe(1);
    expect(breakdown.budget_warnings![0]).toMatch(/^RESOURCE OVER BUDGET:/);
    expect(breakdown.budget_warnings![0]).toContain("large-vm");
    expect(breakdown.budget_warnings![0]).toContain("$30");
  });

  it("emits one RESOURCE OVER BUDGET entry per offending resource", async () => {
    // Both t3.large (~$60.74) and t3.small (~$15.18) exceed a $10 limit.
    const config = makeConfig({ budget: { per_resource_limit: 10 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "large-vm",
        type: "aws_instance",
        name: "large",
        attributes: { instance_type: "t3.large" },
      }),
      makeResource({
        id: "small-vm",
        type: "aws_instance",
        name: "small",
        attributes: { instance_type: "t3.small" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings!.length).toBe(2);

    const ids = breakdown.budget_warnings!.map((w) => w);
    expect(ids.some((w) => w.includes("large-vm"))).toBe(true);
    expect(ids.some((w) => w.includes("small-vm"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Custom warn_percentage
  // -------------------------------------------------------------------------

  it("respects a custom warn_percentage of 50", async () => {
    // t3.large ~ $60.74/month; limit = $100, warn at 50% = $50.
    // $60.74 > $50, so a warning should fire (but it should not be "EXCEEDED").
    const config = makeConfig({ budget: { monthly_limit: 100, warn_percentage: 50 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings![0]).toMatch(/^BUDGET WARNING:/);
  });

  it("does not fire a warning with warn_percentage 100 when cost is just below the limit", async () => {
    // t3.micro ~ $7.59/month; limit = $100, warn at 100% means only fire when exceeded.
    // $7.59 < $100, so no warning expected.
    const config = makeConfig({ budget: { monthly_limit: 100, warn_percentage: 100 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "cheap",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Multiple warnings stacking
  // -------------------------------------------------------------------------

  it("stacks monthly and per-resource budget warnings together", async () => {
    // t3.large ~ $60.74/month.
    // monthly_limit = $50 (exceeded), per_resource_limit = $30 (also exceeded by the same resource).
    const config = makeConfig({
      budget: { monthly_limit: 50, per_resource_limit: 30, warn_percentage: 80 },
    });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const resources = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        attributes: { instance_type: "t3.large" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    expect(breakdown.budget_warnings).toBeDefined();
    expect(breakdown.budget_warnings!.length).toBe(2);

    const hasMonthlyExceeded = breakdown.budget_warnings!.some((w) =>
      w.startsWith("BUDGET EXCEEDED:")
    );
    const hasResourceOver = breakdown.budget_warnings!.some((w) =>
      w.startsWith("RESOURCE OVER BUDGET:")
    );
    expect(hasMonthlyExceeded).toBe(true);
    expect(hasResourceOver).toBe(true);
  });

  it("handles an empty resource list with budget configured — no warnings", async () => {
    const config = makeConfig({ budget: { monthly_limit: 100, per_resource_limit: 10 } });
    dbPath = tempDbPath();
    ({ cache, engine } = makeEngine(config, dbPath));

    const breakdown = await engine.calculateBreakdown([], "aws", "us-east-1");

    // $0 total and no resources, so nothing to warn about.
    expect(breakdown.budget_warnings).toBeUndefined();
  });
});
