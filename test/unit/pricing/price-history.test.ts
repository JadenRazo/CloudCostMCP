import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { tempDbPath } from "../../helpers/factories.js";

describe("PricingCache – price history", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-history-test");
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
  // Record and retrieve
  // -------------------------------------------------------------------------

  it("records a price point and retrieves it via getPriceHistory", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs", "bulk-csv");

    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1");
    expect(history).toHaveLength(1);
    expect(history[0].price_per_unit).toBe(0.0832);
    expect(history[0].unit).toBe("Hrs");
    expect(history[0].currency).toBe("USD");
    expect(history[0].pricing_source).toBe("bulk-csv");
    expect(history[0].recorded_at).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  it("deduplicates when the same price is recorded consecutively", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");

    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1");
    expect(history).toHaveLength(1);
  });

  it("records a new point when the price changes", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0816, "Hrs");
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");

    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1");
    expect(history).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Query with limit
  // -------------------------------------------------------------------------

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) {
      cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.08 + i * 0.01, "Hrs");
    }

    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1", { limit: 3 });
    expect(history).toHaveLength(3);
    // Most recent first
    expect(history[0].price_per_unit).toBeCloseTo(0.12);
  });

  // -------------------------------------------------------------------------
  // Query with since date
  // -------------------------------------------------------------------------

  it("filters by since date", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");

    // Use a date far in the future so nothing matches
    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1", {
      since: "2099-01-01",
    });
    expect(history).toHaveLength(0);

    // Use a date in the past so everything matches
    const all = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1", {
      since: "2000-01-01",
    });
    expect(all).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // getPriceChange
  // -------------------------------------------------------------------------

  it("returns price change when two data points exist", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.08, "Hrs");
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.1, "Hrs");

    const change = cache.getPriceChange("aws", "ec2", "t3.large", "us-east-1");
    expect(change).not.toBeNull();
    expect(change!.current_price).toBe(0.1);
    expect(change!.previous_price).toBe(0.08);
    expect(change!.change_amount).toBeCloseTo(0.02);
    expect(change!.change_percent).toBeCloseTo(25);
  });

  it("returns null when fewer than two data points exist", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");

    const change = cache.getPriceChange("aws", "ec2", "t3.large", "us-east-1");
    expect(change).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty history
  // -------------------------------------------------------------------------

  it("returns empty array when no history exists", () => {
    const history = cache.getPriceHistory("aws", "ec2", "nonexistent", "us-east-1");
    expect(history).toEqual([]);
  });

  it("returns null change when no history exists", () => {
    const change = cache.getPriceChange("aws", "ec2", "nonexistent", "us-east-1");
    expect(change).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Multiple resources don't interfere
  // -------------------------------------------------------------------------

  it("keeps history separate per resource", () => {
    cache.recordPricePoint("aws", "ec2", "t3.large", "us-east-1", 0.0832, "Hrs");
    cache.recordPricePoint("aws", "ec2", "t3.micro", "us-east-1", 0.0104, "Hrs");
    cache.recordPricePoint("gcp", "compute", "e2-standard-2", "us-central1", 0.067, "Hrs");

    const largHist = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1");
    expect(largHist).toHaveLength(1);
    expect(largHist[0].price_per_unit).toBe(0.0832);

    const microHist = cache.getPriceHistory("aws", "ec2", "t3.micro", "us-east-1");
    expect(microHist).toHaveLength(1);
    expect(microHist[0].price_per_unit).toBe(0.0104);

    const gcpHist = cache.getPriceHistory("gcp", "compute", "e2-standard-2", "us-central1");
    expect(gcpHist).toHaveLength(1);
    expect(gcpHist[0].price_per_unit).toBe(0.067);
  });

  // -------------------------------------------------------------------------
  // Auto-recording via cache.set()
  // -------------------------------------------------------------------------

  it("automatically records price history when cache.set() stores a price object", () => {
    cache.set(
      "aws/ec2/us-east-1/t3.large",
      { price_per_unit: 0.0832, unit: "Hrs", currency: "USD" },
      "aws",
      "ec2",
      "us-east-1",
      3600,
    );

    const history = cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1");
    expect(history).toHaveLength(1);
    expect(history[0].price_per_unit).toBe(0.0832);
  });

  it("does not record history when cached data is not a price object", () => {
    cache.set(
      "aws/ec2/us-east-1/metadata",
      { regions: ["us-east-1"] },
      "aws",
      "ec2",
      "us-east-1",
      3600,
    );

    const history = cache.getPriceHistory("aws", "ec2", "metadata", "us-east-1");
    expect(history).toHaveLength(0);
  });
});
