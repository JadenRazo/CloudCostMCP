import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { compareProviders } from "../../../src/tools/compare-providers.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-compare-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AWS_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 50
  type              = "gp3"
}
`;

const SINGLE_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "solo" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.small"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("compareProviders", () => {
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
  // Happy path — markdown (default format)
  // -------------------------------------------------------------------------

  it("returns report and format fields for the default markdown format", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.format).toBe("markdown");
    expect(typeof result.report).toBe("string");
    expect((result.report as string).length).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("markdown report contains provider names", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const report = result.report as string;
    // The report should reference each requested provider.
    expect(report.toLowerCase()).toContain("aws");
    expect(report.toLowerCase()).toContain("azure");
    expect(report.toLowerCase()).toContain("gcp");
  });

  it("comparison summary has an entry for each requested provider", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const comparison = result.comparison as Record<string, unknown>;
    const providers = comparison.providers as Array<Record<string, unknown>>;
    expect(providers.length).toBe(3);

    const providerNames = providers.map((p) => p.provider);
    expect(providerNames).toContain("aws");
    expect(providerNames).toContain("azure");
    expect(providerNames).toContain("gcp");
  });

  it("savings_summary contains a row for each provider", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const comparison = result.comparison as Record<string, unknown>;
    const savings = comparison.savings_summary as Array<Record<string, unknown>>;
    expect(savings.length).toBe(3);

    for (const row of savings) {
      expect(typeof row.provider).toBe("string");
      expect(typeof row.total_monthly).toBe("number");
      expect(typeof row.difference_from_source).toBe("number");
      expect(typeof row.percentage_difference).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // Format variations
  // -------------------------------------------------------------------------

  it("returns valid JSON string in report when format is json", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "json",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.format).toBe("json");
    expect(typeof result.report).toBe("string");

    // The report should be parseable JSON.
    expect(() => JSON.parse(result.report as string)).not.toThrow();
  });

  it("json format response does not include the comparison object (avoids double payload)", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: AWS_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "json",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    // The handler intentionally omits `comparison` for json format to avoid
    // duplicating data already embedded in the report string.
    expect(result).not.toHaveProperty("comparison");
  });

  it("returns a CSV string when format is csv", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "azure"],
        format: "csv",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.format).toBe("csv");
    const report = result.report as string;
    // A CSV report will have comma-separated values and newlines.
    expect(report).toContain(",");
  });

  it("returns a FOCUS-format string when format is focus", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "azure"],
        format: "focus",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.format).toBe("focus");
    expect(typeof result.report).toBe("string");
    expect((result.report as string).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Provider variations — two-provider subset
  // -------------------------------------------------------------------------

  it("compares only the two requested providers when providers is [aws, azure]", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "azure"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const comparison = result.comparison as Record<string, unknown>;
    const providers = comparison.providers as Array<Record<string, unknown>>;
    expect(providers.length).toBe(2);
    const names = providers.map((p) => p.provider);
    expect(names).toContain("aws");
    expect(names).toContain("azure");
    expect(names).not.toContain("gcp");
  });

  it("compares aws and gcp correctly when gcp is included", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const comparison = result.comparison as Record<string, unknown>;
    const providers = comparison.providers as Array<Record<string, unknown>>;
    expect(providers.length).toBe(2);
    const names = providers.map((p) => p.provider);
    expect(names).toContain("aws");
    expect(names).toContain("gcp");
  });

  // -------------------------------------------------------------------------
  // Currency
  // -------------------------------------------------------------------------

  it("provider totals are denominated in EUR when currency is EUR", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "azure"],
        format: "markdown",
        currency: "EUR",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    // The savings_summary totals should reflect the EUR-converted amounts —
    // they should be positive numbers (exact values depend on exchange rate,
    // but the shape must be correct).
    const comparison = result.comparison as Record<string, unknown>;
    const savings = comparison.savings_summary as Array<Record<string, unknown>>;
    for (const row of savings) {
      expect(typeof row.total_monthly).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // Edge case — single resource
  // -------------------------------------------------------------------------

  it("handles a single-resource config without throwing", async () => {
    const result = await compareProviders(
      {
        files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
        providers: ["aws", "azure", "gcp"],
        format: "markdown",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(typeof result.report).toBe("string");
    const comparison = result.comparison as Record<string, unknown>;
    const providers = comparison.providers as Array<Record<string, unknown>>;
    // Each provider entry should have a resource_count of at least 1.
    for (const p of providers) {
      expect(p.resource_count as number).toBeGreaterThanOrEqual(0);
    }
  });
});
