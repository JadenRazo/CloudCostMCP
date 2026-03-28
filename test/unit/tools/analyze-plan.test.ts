import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { analyzePlan } from "../../../src/tools/analyze-plan.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-analyze-plan-test-${suffix}`, "cache.db");
}

function makePlan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: "1.0",
    terraform_version: "1.5.0",
    resource_changes: [],
    ...overrides,
  });
}

function makeResourceChange(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "aws_instance.web",
    type: "aws_instance",
    name: "web",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: {
      actions: ["create"],
      before: null,
      after: { instance_type: "t3.large", ami: "ami-12345" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("analyzePlan", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Create-only plan
  // -------------------------------------------------------------------------

  it("returns cost diff for a create-only plan", async () => {
    const planJson = makePlan({
      resource_changes: [
        makeResourceChange(),
        makeResourceChange({
          address: "aws_ebs_volume.data",
          type: "aws_ebs_volume",
          name: "data",
          change: {
            actions: ["create"],
            before: null,
            after: { size: 100, type: "gp3", availability_zone: "us-east-1a" },
          },
        }),
      ],
    });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "USD" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.provider).toBe("aws");
    expect(result.currency).toBe("USD");
    expect(result.summary.creates).toBe(2);
    expect(result.total_before_monthly).toBe(0);
    expect(result.total_after_monthly).toBeGreaterThanOrEqual(0);
    expect(result.total_delta_monthly).toBe(result.total_after_monthly);
    expect(result.resource_diffs).toHaveLength(2);

    for (const diff of result.resource_diffs) {
      expect(diff.action).toBe("create");
      expect(diff.before_monthly).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Delete-only plan
  // -------------------------------------------------------------------------

  it("returns cost diff for a delete-only plan", async () => {
    const planJson = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["delete"],
            before: { instance_type: "t3.micro", ami: "ami-old" },
            after: null,
          },
        }),
      ],
    });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "USD" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.summary.deletes).toBe(1);
    expect(result.total_after_monthly).toBe(0);
    expect(result.total_delta_monthly).toBeLessThanOrEqual(0);

    const diff = result.resource_diffs[0];
    expect(diff.action).toBe("delete");
    expect(diff.after_monthly).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Update plan (instance type change)
  // -------------------------------------------------------------------------

  it("returns cost diff for an update plan", async () => {
    const planJson = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["update"],
            before: { instance_type: "t3.micro", ami: "ami-12345" },
            after: { instance_type: "t3.large", ami: "ami-12345" },
          },
        }),
      ],
    });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "USD" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.summary.updates).toBe(1);
    expect(result.resource_diffs).toHaveLength(1);
    expect(result.resource_diffs[0].action).toBe("update");

    // Both before and after should have costs (non-zero or zero depending on
    // fallback pricing, but the structure must be valid)
    expect(typeof result.resource_diffs[0].before_monthly).toBe("number");
    expect(typeof result.resource_diffs[0].after_monthly).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Mixed actions
  // -------------------------------------------------------------------------

  it("handles mixed create/update/delete actions", async () => {
    const planJson = makePlan({
      resource_changes: [
        makeResourceChange({
          address: "aws_instance.new_one",
          name: "new_one",
          change: {
            actions: ["create"],
            before: null,
            after: { instance_type: "t3.micro" },
          },
        }),
        makeResourceChange({
          address: "aws_instance.updated",
          name: "updated",
          change: {
            actions: ["update"],
            before: { instance_type: "t3.micro" },
            after: { instance_type: "t3.large" },
          },
        }),
        makeResourceChange({
          address: "aws_instance.removed",
          name: "removed",
          change: {
            actions: ["delete"],
            before: { instance_type: "t3.small" },
            after: null,
          },
        }),
      ],
    });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "USD" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.summary.creates).toBe(1);
    expect(result.summary.updates).toBe(1);
    expect(result.summary.deletes).toBe(1);
    expect(result.resource_diffs).toHaveLength(3);

    const actions = result.resource_diffs.map((d) => d.action);
    expect(actions).toContain("create");
    expect(actions).toContain("update");
    expect(actions).toContain("delete");
  });

  // -------------------------------------------------------------------------
  // Empty plan
  // -------------------------------------------------------------------------

  it("handles an empty plan with no changes", async () => {
    const planJson = makePlan({ resource_changes: [] });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "USD" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.total_before_monthly).toBe(0);
    expect(result.total_after_monthly).toBe(0);
    expect(result.total_delta_monthly).toBe(0);
    expect(result.resource_diffs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  it("throws on invalid JSON input", async () => {
    await expect(
      analyzePlan({ plan_json: "not json", currency: "USD" }, pricingEngine, DEFAULT_CONFIG),
    ).rejects.toThrow("Invalid plan JSON");
  });

  it("throws when resource_changes is missing", async () => {
    const planJson = JSON.stringify({ format_version: "1.0" });
    await expect(
      analyzePlan({ plan_json: planJson, currency: "USD" }, pricingEngine, DEFAULT_CONFIG),
    ).rejects.toThrow("missing or non-array resource_changes");
  });

  // -------------------------------------------------------------------------
  // Provider override
  // -------------------------------------------------------------------------

  it("respects explicit provider and region overrides", async () => {
    const planJson = makePlan({
      resource_changes: [makeResourceChange()],
    });

    const result = await analyzePlan(
      {
        plan_json: planJson,
        provider: "aws",
        region: "eu-west-1",
        currency: "USD",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("eu-west-1");
  });

  // -------------------------------------------------------------------------
  // Currency conversion
  // -------------------------------------------------------------------------

  it("applies currency conversion when non-USD currency is requested", async () => {
    const planJson = makePlan({
      resource_changes: [makeResourceChange()],
    });

    const result = await analyzePlan(
      { plan_json: planJson, currency: "EUR" },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.currency).toBe("EUR");
    for (const diff of result.resource_diffs) {
      expect(diff.currency).toBe("EUR");
    }
  });
});
