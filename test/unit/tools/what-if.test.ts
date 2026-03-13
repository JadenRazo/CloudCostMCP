import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { whatIf } from "../../../src/tools/what-if.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-whatif-test-${suffix}`, "cache.db");
}

// Minimal Terraform fixture with two AWS instances and one EBS volume so that
// each test has predictable resources to work with.
const SIMPLE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_instance" "api" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.small"
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 100
  type              = "gp3"
}
`;

const SIMPLE_FILES = [{ path: "main.tf", content: SIMPLE_TF }];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("whatIf", () => {
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
  // Changing instance type changes cost
  // -------------------------------------------------------------------------

  it("upgrading instance type increases monthly cost", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_instance.web",
            attribute: "instance_type",
            new_value: "t3.large",
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    // t3.large is more expensive than t3.micro so the total should increase.
    expect(result.total_delta_monthly).toBeGreaterThan(0);
    expect(result.new_total_monthly).toBeGreaterThan(result.original_total_monthly);
    expect(result.total_delta_yearly).toBeCloseTo(result.total_delta_monthly * 12, 1);
  });

  it("downgrading instance type decreases monthly cost", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_instance.api",
            attribute: "instance_type",
            new_value: "t3.nano",
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    // t3.nano < t3.small so the delta should be negative.
    expect(result.total_delta_monthly).toBeLessThan(0);
    expect(result.new_total_monthly).toBeLessThan(result.original_total_monthly);
  });

  // -------------------------------------------------------------------------
  // Multiple changes applied correctly
  // -------------------------------------------------------------------------

  it("applies multiple changes and reports all of them in changes_applied", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_instance.web",
            attribute: "instance_type",
            new_value: "t3.large",
          },
          {
            resource_id: "aws_instance.api",
            attribute: "instance_type",
            new_value: "t3.medium",
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    expect(result.changes_applied).toHaveLength(2);
    expect(result.changes_applied.map((c) => c.resource_id)).toContain(
      "aws_instance.web"
    );
    expect(result.changes_applied.map((c) => c.resource_id)).toContain(
      "aws_instance.api"
    );
  });

  it("per-resource diff shows the changed resource with a non-zero delta", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_instance.web",
            attribute: "instance_type",
            new_value: "t3.large",
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    const webDiff = result.resource_diffs.find(
      (d) => d.resource_id === "aws_instance.web"
    );
    expect(webDiff).toBeDefined();
    expect(webDiff!.delta_monthly).toBeGreaterThan(0);
    expect(webDiff!.new_monthly).toBeGreaterThan(webDiff!.original_monthly);
  });

  // -------------------------------------------------------------------------
  // Unknown resource_id is handled gracefully (warning, not error)
  // -------------------------------------------------------------------------

  it("unknown resource_id produces a warning but does not throw", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_instance.nonexistent",
            attribute: "instance_type",
            new_value: "t3.large",
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    // The change for the missing resource is skipped; changes_applied should
    // be empty and a warning should be surfaced to the caller.
    expect(result.changes_applied).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.includes("aws_instance.nonexistent"))
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No changes returns zero delta
  // -------------------------------------------------------------------------

  it("empty changes array returns zero delta and matching totals", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    expect(result.total_delta_monthly).toBe(0);
    expect(result.total_delta_yearly).toBe(0);
    expect(result.total_pct_change).toBe(0);
    expect(result.new_total_monthly).toBeCloseTo(result.original_total_monthly, 2);
  });

  // -------------------------------------------------------------------------
  // Output includes per-resource breakdown
  // -------------------------------------------------------------------------

  it("resource_diffs contains an entry for every parsed resource", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    // The fixture has 3 resources: web, api, data.
    expect(result.resource_diffs.length).toBeGreaterThanOrEqual(3);
  });

  it("each resource_diff entry has required fields", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    for (const diff of result.resource_diffs) {
      expect(typeof diff.resource_id).toBe("string");
      expect(typeof diff.resource_type).toBe("string");
      expect(typeof diff.resource_name).toBe("string");
      expect(typeof diff.original_monthly).toBe("number");
      expect(typeof diff.new_monthly).toBe("number");
      expect(typeof diff.delta_monthly).toBe("number");
      expect(typeof diff.pct_change).toBe("number");
      expect(typeof diff.currency).toBe("string");
      expect(Array.isArray(diff.changes_applied)).toBe(true);
    }
  });

  it("result includes provider, region, and generated_at fields", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("us-east-1");
    expect(typeof result.generated_at).toBe("string");
    expect(new Date(result.generated_at).getTime()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Storage attribute changes
  // -------------------------------------------------------------------------

  it("increasing storage_size_gb on an EBS volume increases cost", async () => {
    const result = await whatIf(
      {
        files: SIMPLE_FILES,
        changes: [
          {
            resource_id: "aws_ebs_volume.data",
            attribute: "storage_size_gb",
            new_value: 500,
          },
        ],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    );

    const ebsDiff = result.resource_diffs.find(
      (d) => d.resource_id === "aws_ebs_volume.data"
    );
    expect(ebsDiff).toBeDefined();
    // 500 GB > 100 GB so the cost must increase.
    expect(ebsDiff!.delta_monthly).toBeGreaterThan(0);
  });
});
