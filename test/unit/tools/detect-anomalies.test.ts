import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { detectAnomalies } from "../../../src/tools/detect-anomalies.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-anomaly-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SMALL_INFRA_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}
`;

const MULTI_RESOURCE_TF = `
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

const EXPENSIVE_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "big" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "m5.4xlarge"
}
`;

const CONCENTRATION_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "big" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "m5.2xlarge"
}

resource "aws_instance" "tiny" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.nano"
}
`;

const EMPTY_TF = `
provider "aws" {
  region = "us-east-1"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("detectAnomalies", () => {
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
  // No anomalies on small infrastructure
  // -------------------------------------------------------------------------

  it("reports no anomalies for small infrastructure within budget", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: SMALL_INFRA_TF }],
        provider: "aws",
        region: "us-east-1",
        budget_monthly: 10000,
        budget_per_resource: 5000,
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    expect(result.total_monthly).toBeGreaterThanOrEqual(0);
    expect(result.summary.total_resources).toBeGreaterThanOrEqual(1);

    // No budget anomalies because thresholds are very high
    const budgetAnomalies = result.anomalies.filter((a) => a.type === "budget_exceeded");
    expect(budgetAnomalies).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Budget monthly exceeded
  // -------------------------------------------------------------------------

  it("flags when total monthly cost exceeds budget", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
        provider: "aws",
        region: "us-east-1",
        budget_monthly: 0.01, // Very low budget to guarantee trigger
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    const budgetAnomalies = result.anomalies.filter(
      (a) => a.type === "budget_exceeded" && a.resource === "_total",
    );
    expect(budgetAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(budgetAnomalies[0].severity).toBe("high");
    expect(budgetAnomalies[0].details.threshold).toBe(0.01);
    expect(result.summary.high_severity).toBeGreaterThanOrEqual(1);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Budget per-resource exceeded
  // -------------------------------------------------------------------------

  it("flags when a resource exceeds per-resource budget", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
        provider: "aws",
        region: "us-east-1",
        budget_per_resource: 0.01, // Very low to guarantee trigger
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    const perResourceAnomalies = result.anomalies.filter(
      (a) => a.type === "budget_exceeded" && a.resource !== "_total",
    );
    expect(perResourceAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(perResourceAnomalies[0].severity).toBe("high");
    expect(perResourceAnomalies[0].details.threshold).toBe(0.01);
  });

  // -------------------------------------------------------------------------
  // Cost concentration detection
  // -------------------------------------------------------------------------

  it("flags cost concentration when one resource dominates total cost", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: CONCENTRATION_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    // The m5.2xlarge should dominate the tiny t3.nano
    const concentrationAnomalies = result.anomalies.filter((a) => a.type === "cost_concentration");
    expect(concentrationAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(concentrationAnomalies[0].severity).toBe("medium");
    expect(concentrationAnomalies[0].details.cost_share_percent).toBeGreaterThan(50);
  });

  // -------------------------------------------------------------------------
  // Right-sizing hint for large instances
  // -------------------------------------------------------------------------

  it("flags potential oversizing for xlarge instances", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: EXPENSIVE_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    const oversizingAnomalies = result.anomalies.filter((a) => a.type === "potential_oversizing");
    expect(oversizingAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(oversizingAnomalies[0].severity).toBe("low");
    expect(oversizingAnomalies[0].message).toContain("4xlarge");
  });

  // -------------------------------------------------------------------------
  // Empty infrastructure returns no anomalies
  // -------------------------------------------------------------------------

  it("returns no anomalies for empty infrastructure", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: EMPTY_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    expect(result.total_monthly).toBe(0);
    expect(result.anomalies).toHaveLength(0);
    expect(result.summary.anomaly_count).toBe(0);
    expect(result.summary.total_resources).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Custom thresholds work
  // -------------------------------------------------------------------------

  it("respects custom price_change_threshold", async () => {
    // Seed a price history with a large change for ec2/t3.micro
    cache.recordPricePoint("aws", "ec2", "t3.micro", "us-east-1", 0.005, "Hrs", "test");
    cache.recordPricePoint("aws", "ec2", "t3.micro", "us-east-1", 0.01, "Hrs", "test");

    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: SMALL_INFRA_TF }],
        provider: "aws",
        region: "us-east-1",
        price_change_threshold: 5, // 5% — the 100% change should trigger
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    // The seeded 100% price change should trigger a price_change anomaly
    const priceAnomalies = result.anomalies.filter((a) => a.type === "price_change");
    expect(priceAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(priceAnomalies[0].details.price_change_percent).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Result structure validation
  // -------------------------------------------------------------------------

  it("returns the expected result structure", async () => {
    const result = await detectAnomalies(
      {
        files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
        provider: "aws",
        region: "us-east-1",
        budget_monthly: 0.01,
      },
      pricingEngine,
      cache,
      DEFAULT_CONFIG,
    );

    // Top-level fields
    expect(typeof result.total_monthly).toBe("number");
    expect(Array.isArray(result.anomalies)).toBe(true);
    expect(typeof result.summary).toBe("object");
    expect(Array.isArray(result.recommendations)).toBe(true);

    // Summary fields
    expect(typeof result.summary.total_resources).toBe("number");
    expect(typeof result.summary.anomaly_count).toBe("number");
    expect(typeof result.summary.high_severity).toBe("number");
    expect(typeof result.summary.medium_severity).toBe("number");
    expect(typeof result.summary.low_severity).toBe("number");

    // Anomaly entry fields
    if (result.anomalies.length > 0) {
      const anomaly = result.anomalies[0];
      expect(typeof anomaly.type).toBe("string");
      expect(typeof anomaly.severity).toBe("string");
      expect(typeof anomaly.resource).toBe("string");
      expect(typeof anomaly.resource_type).toBe("string");
      expect(typeof anomaly.message).toBe("string");
      expect(typeof anomaly.details).toBe("object");
    }

    // Summary counts should be consistent
    expect(result.summary.anomaly_count).toBe(result.anomalies.length);
    expect(
      result.summary.high_severity + result.summary.medium_severity + result.summary.low_severity,
    ).toBe(result.summary.anomaly_count);
  });
});
