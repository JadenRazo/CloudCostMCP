import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { makeResource, tempDbPath } from "../../helpers/factories.js";

/**
 * Regression cover for a bug that reached production in 1.2.1.
 *
 * cost-engine.ts only pushed a warning when `pricing_source === "fallback"`.
 * GCP's bundled tables are tagged `"bundled"`, and the live GCP path returns
 * null on a 403 so GcpProvider always serves them — which meant a GCP estimate
 * priced from a four-month-old file came back with an empty `warnings` array,
 * while README stated "the response includes a `warnings` entry" for exactly
 * this case. AWS and Azure degradation was visible; GCP's was not.
 *
 * The assertion that matters is the negative one: `warnings` must not be empty
 * for a non-live estimate. A test that only checked the AWS path would have
 * passed throughout the whole life of the bug.
 */
describe("non-live pricing is surfaced to the caller", () => {
  let dbPath: string;
  let cache: PricingCache;
  let engine: CostEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-bundled-warn-test");
    cache = new PricingCache(dbPath);
    engine = new CostEngine(new PricingEngine(cache, DEFAULT_CONFIG), DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("warns when a GCP estimate is priced from bundled data", async () => {
    const resource = makeResource({
      id: "gcp-vm-1",
      type: "google_compute_instance",
      name: "api-server",
      provider: "gcp",
      region: "us-central1",
      attributes: { machine_type: "e2-standard-2" },
    });

    const breakdown = await engine.calculateBreakdown([resource], "gcp", "us-central1");

    const estimate = breakdown.by_resource.find((e) => e.resource_id === "gcp-vm-1");
    expect(estimate).toBeDefined();

    // Precondition: if GCP ever starts resolving live, this test is asserting
    // nothing and should be revisited rather than silently passing.
    expect(estimate?.pricing_source).not.toBe("live");

    expect(breakdown.warnings.length).toBeGreaterThan(0);
    const warning = breakdown.warnings.find((w) => w.includes("api-server"));
    expect(
      warning,
      "a bundled/fallback estimate must produce a warning naming the resource",
    ).toBeDefined();
    expect(warning).toMatch(/not live pricing/);
  });

  it("names the data vintage so the caller can judge it", async () => {
    const resource = makeResource({
      id: "gcp-vm-2",
      type: "google_compute_instance",
      name: "worker",
      provider: "gcp",
      region: "us-central1",
      attributes: { machine_type: "e2-standard-2" },
    });

    const breakdown = await engine.calculateBreakdown([resource], "gcp", "us-central1");
    const warning = breakdown.warnings.find((w) => w.includes("worker"));

    // "using fallback/bundled pricing data" told the caller nothing actionable.
    // A date and an age is the difference between a note and a decision.
    expect(warning).toMatch(/as of \d{4}-\d{2}-\d{2}|vintage unknown/);
    expect(warning).toMatch(/days old|vintage unknown/);
    expect(warning).toMatch(/fresh|aging|stale|vintage unknown/);
  });

  it("still warns on the AWS fallback path", async () => {
    // The behaviour that already worked, pinned so widening the condition to
    // cover "bundled" cannot regress it.
    const resource = makeResource({
      id: "aws-vm-1",
      type: "aws_instance",
      name: "legacy-box",
      provider: "aws",
      region: "us-east-1",
      attributes: { instance_type: "t3.large" },
    });

    const breakdown = await engine.calculateBreakdown([resource], "aws", "us-east-1");
    const estimate = breakdown.by_resource.find((e) => e.resource_id === "aws-vm-1");

    if (estimate?.pricing_source === "live") {
      // Live pricing reached the network; nothing to warn about.
      expect(breakdown.warnings.filter((w) => w.includes("legacy-box"))).toHaveLength(0);
      return;
    }

    expect(breakdown.warnings.find((w) => w.includes("legacy-box"))).toBeDefined();
  });
});
