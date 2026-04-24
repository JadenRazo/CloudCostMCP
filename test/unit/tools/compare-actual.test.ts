import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { compareActual } from "../../../src/tools/compare-actual.js";
import { tempDbPath } from "../../helpers/factories.js";

function makeStateJson(resources: Record<string, unknown>[] = []): string {
  return JSON.stringify({
    version: 4,
    terraform_version: "1.5.0",
    serial: 1,
    lineage: "test-123",
    resources,
  });
}

const AWS_INSTANCE_STATE = {
  mode: "managed" as const,
  type: "aws_instance",
  name: "web",
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [
    {
      attributes: {
        id: "i-12345",
        instance_type: "t3.micro",
        ami: "ami-12345",
        availability_zone: "us-east-1a",
        tags: { Name: "web" },
      },
    },
  ],
};

const AWS_EBS_STATE = {
  mode: "managed" as const,
  type: "aws_ebs_volume",
  name: "data",
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [
    {
      attributes: {
        id: "vol-12345",
        size: 100,
        type: "gp3",
        availability_zone: "us-east-1a",
      },
    },
  ],
};

const SIMPLE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 100
  type              = "gp3"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("compareActual", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-compare-actual-test");
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // State-only analysis
  // -------------------------------------------------------------------------

  it("returns actual costs from state without planned files", async () => {
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE, AWS_EBS_STATE]),
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("us-east-1");
    expect(result.currency).toBe("USD");
    expect(result.actual_costs.resource_count).toBe(2);
    expect(result.actual_costs.total_monthly).toBeGreaterThan(0);
    expect(result.actual_costs.total_yearly).toBeCloseTo(result.actual_costs.total_monthly * 12, 0);
    expect(result.actual_costs.by_resource.length).toBeGreaterThanOrEqual(2);
    expect(result.planned_costs).toBeUndefined();
    expect(result.delta).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // State + planned comparison
  // -------------------------------------------------------------------------

  it("compares actual state costs against planned HCL file costs", async () => {
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE, AWS_EBS_STATE]),
        files: [{ path: "main.tf", content: SIMPLE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.actual_costs).toBeDefined();
    expect(result.planned_costs).toBeDefined();
    expect(result.delta).toBeDefined();
    expect(result.planned_costs!.resource_count).toBe(2);
    expect(result.planned_costs!.total_monthly).toBeGreaterThan(0);
    expect(typeof result.delta!.monthly).toBe("number");
    expect(typeof result.delta!.yearly).toBe("number");
    expect(typeof result.delta!.pct_change).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it("handles empty state gracefully", async () => {
    const result = await compareActual(
      {
        state_json: makeStateJson([]),
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.actual_costs.resource_count).toBe(0);
    expect(result.actual_costs.total_monthly).toBe(0);
    expect(result.actual_costs.by_resource).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Invalid state JSON
  // -------------------------------------------------------------------------

  it("handles invalid state JSON with warnings", async () => {
    const result = await compareActual(
      {
        state_json: "not valid json",
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    expect(result.actual_costs.resource_count).toBe(0);
    expect(result.warnings.some((w) => w.includes("Invalid state JSON"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Result structure
  // -------------------------------------------------------------------------

  it("each by_resource entry has required fields", async () => {
    const result = await compareActual(
      {
        state_json: makeStateJson([AWS_INSTANCE_STATE]),
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG,
    );

    for (const entry of result.actual_costs.by_resource) {
      expect(typeof entry.resource_id).toBe("string");
      expect(typeof entry.resource_type).toBe("string");
      expect(typeof entry.monthly_cost).toBe("number");
    }
  });
});
