import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { optimizeCost } from "../../../src/tools/optimize-cost.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-optimize-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A purposely over-specified config so the optimizer has something concrete to
// flag (large instance that could be downsized).
const LARGE_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "heavy" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "m5.4xlarge"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}
`;

const SINGLE_SMALL_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "nano" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.nano"
}
`;

const MULTI_RESOURCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "app" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.small"
}

resource "aws_db_instance" "db" {
  identifier        = "app-db"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.t3.medium"
  allocated_storage = 100
  storage_type      = "gp3"
}

resource "aws_ebs_volume" "disk" {
  availability_zone = "us-east-1a"
  size              = 200
  type              = "gp3"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("optimizeCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
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
  // Happy path — result shape
  // -------------------------------------------------------------------------

  it("returns recommendations, reserved_pricing, and total_potential_savings", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: LARGE_INSTANCE_TF }],
        providers: ["aws", "azure", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(Array.isArray(result.reserved_pricing)).toBe(true);
    expect(typeof result.total_potential_savings).toBe("number");
  });

  it("total_potential_savings is the sum of all recommendation monthly_savings", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
        providers: ["aws", "azure", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const recommendations = result.recommendations as Array<Record<string, unknown>>;
    const summedSavings = recommendations.reduce(
      (acc, r) => acc + (r.monthly_savings as number),
      0
    );
    expect(result.total_potential_savings as number).toBeCloseTo(summedSavings, 2);
  });

  it("total_potential_savings is non-negative", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: LARGE_INSTANCE_TF }],
        providers: ["aws", "azure", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.total_potential_savings as number).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Recommendations shape
  // -------------------------------------------------------------------------

  it("each recommendation entry has the required fields when recommendations exist", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: LARGE_INSTANCE_TF }],
        providers: ["aws", "azure", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const recommendations = result.recommendations as Array<Record<string, unknown>>;
    for (const rec of recommendations) {
      expect(typeof rec.type).toBe("string");
      expect(typeof rec.resource_id).toBe("string");
      expect(typeof rec.monthly_savings).toBe("number");
      expect(rec.monthly_savings as number).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Reserved pricing shape
  // -------------------------------------------------------------------------

  it("reserved_pricing entries have the required fields", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
        providers: ["aws"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const reserved = result.reserved_pricing as Array<Record<string, unknown>>;
    // There should be reserved pricing for resources with a non-zero cost.
    expect(reserved.length).toBeGreaterThan(0);

    for (const entry of reserved) {
      expect(typeof entry.resource_id).toBe("string");
      expect(typeof entry.resource_name).toBe("string");
      expect(typeof entry.resource_type).toBe("string");
      expect(typeof entry.provider).toBe("string");
    }
  });

  it("reserved_pricing is empty when all resources have zero cost", async () => {
    const emptyTf = `
provider "aws" {
  region = "us-east-1"
}
`;
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: emptyTf }],
        providers: ["aws"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const reserved = result.reserved_pricing as Array<Record<string, unknown>>;
    expect(reserved.length).toBe(0);
    expect(result.total_potential_savings).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Provider variations
  // -------------------------------------------------------------------------

  it("runs against only aws when providers is [aws]", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: SINGLE_SMALL_INSTANCE_TF }],
        providers: ["aws"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    // Should complete without throwing and return the standard structure.
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(Array.isArray(result.reserved_pricing)).toBe(true);
    expect(typeof result.total_potential_savings).toBe("number");
  });

  it("runs against aws and gcp when providers is [aws, gcp]", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: SINGLE_SMALL_INSTANCE_TF }],
        providers: ["aws", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(typeof result.total_potential_savings).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Edge case — single tiny resource
  // -------------------------------------------------------------------------

  it("handles a single minimal resource without throwing", async () => {
    const result = await optimizeCost(
      {
        files: [{ path: "main.tf", content: SINGLE_SMALL_INSTANCE_TF }],
        providers: ["aws", "azure", "gcp"],
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(typeof result.total_potential_savings).toBe("number");
    expect(result.total_potential_savings as number).toBeGreaterThanOrEqual(0);
  });
});
