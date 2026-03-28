import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { priceTrends } from "../../../src/tools/price-trends.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-pricetrends-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("priceTrends", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Basic price trend query
  // -------------------------------------------------------------------------

  it("returns price history and change for a resource with data", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0816, "Hrs");
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");

    const result = priceTrends(
      {
        provider: "aws",
        service: "ec2",
        resource_type: "t3.large",
        region: "us-east-1",
        limit: 30,
      },
      cache,
    ) as Record<string, unknown>;

    expect(result.provider).toBe("aws");
    expect(result.service).toBe("ec2");
    expect(result.resource_type).toBe("t3.large");
    expect(result.region).toBe("us-east-1");
    expect(result.data_points).toBe(2);

    const currentPrice = result.current_price as Record<string, unknown>;
    expect(currentPrice.price_per_unit).toBe(0.0832);
    expect(currentPrice.unit).toBe("Hrs");

    const change = result.price_change as Record<string, unknown>;
    expect(change.current_price).toBe(0.0832);
    expect(change.previous_price).toBe(0.0816);
    expect(typeof change.change_percent).toBe("number");
  });

  // -------------------------------------------------------------------------
  // With limit parameter
  // -------------------------------------------------------------------------

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.08 + i * 0.001, "Hrs");
    }

    const result = priceTrends(
      {
        provider: "aws",
        service: "ec2",
        resource_type: "t3.large",
        region: "us-east-1",
        limit: 5,
      },
      cache,
    ) as Record<string, unknown>;

    expect(result.data_points).toBe(5);
    expect((result.price_history as unknown[]).length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Empty history
  // -------------------------------------------------------------------------

  it("returns empty results when no history exists", () => {
    const result = priceTrends(
      {
        provider: "aws",
        service: "ec2",
        resource_type: "nonexistent",
        region: "us-east-1",
        limit: 30,
      },
      cache,
    ) as Record<string, unknown>;

    expect(result.current_price).toBeNull();
    expect(result.price_history).toEqual([]);
    expect(result.price_change).toBeNull();
    expect(result.data_points).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Auto-recording via cache set
  // -------------------------------------------------------------------------

  it("shows data that was auto-recorded via cache.set()", () => {
    cache.set(
      "aws/ec2/us-east-1/t3.large",
      { price_per_unit: 0.0832, unit: "Hrs", currency: "USD" },
      "aws",
      "ec2",
      "us-east-1",
      3600,
    );

    const result = priceTrends(
      {
        provider: "aws",
        service: "ec2",
        resource_type: "t3.large",
        region: "us-east-1",
        limit: 30,
      },
      cache,
    ) as Record<string, unknown>;

    expect(result.data_points).toBe(1);
    const currentPrice = result.current_price as Record<string, unknown>;
    expect(currentPrice.price_per_unit).toBe(0.0832);
  });
});
