import { bench, describe, beforeAll, afterAll } from "vitest";
import { PricingCache } from "../../src/pricing/cache.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let cache: PricingCache;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bench-pricing-"));
  cache = new PricingCache(join(tmpDir, "bench.db"));

  // Pre-populate cache entries for hit/miss and history benchmarks.
  for (let i = 0; i < 100; i++) {
    cache.set(
      `aws/ec2/us-east-1/t3.large-${i}`,
      { price_per_unit: 0.0832 + i * 0.001, unit: "Hrs" },
      "aws",
      "ec2",
      "us-east-1",
      86400,
    );
  }

  // Pre-populate price history for getPriceHistory benchmark.
  for (let i = 0; i < 30; i++) {
    cache.recordPricePoint(
      "aws",
      "ec2",
      "t3.large",
      "us-east-1",
      0.0832 + i * 0.0001,
      "Hrs",
      "benchmark",
    );
  }
});

afterAll(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PricingCache operations", () => {
  let setCounter = 0;

  bench("cache.set", () => {
    setCounter++;
    cache.set(
      `aws/ec2/us-east-1/bench-set-${setCounter}`,
      { price_per_unit: 0.0832, unit: "Hrs" },
      "aws",
      "ec2",
      "us-east-1",
      86400,
    );
  });

  bench("cache.get - hit", () => {
    cache.get("aws/ec2/us-east-1/t3.large-50");
  });

  bench("cache.get - miss", () => {
    cache.get("aws/ec2/eu-west-1/nonexistent-instance");
  });
});

describe("Price history operations", () => {
  let pointCounter = 0;

  bench("recordPricePoint", () => {
    pointCounter++;
    cache.recordPricePoint(
      "aws",
      "ec2",
      `bench-instance-${pointCounter}`,
      "us-east-1",
      0.0832 + pointCounter * 0.00001,
      "Hrs",
      "benchmark",
    );
  });

  bench("getPriceHistory", () => {
    cache.getPriceHistory("aws", "ec2", "t3.large", "us-east-1", { limit: 30 });
  });
});
