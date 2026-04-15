/**
 * AWS pricing smoke test.
 *
 * Gated behind RUN_INTEGRATION=1. Makes one live request to the AWS Bulk
 * Pricing API to verify the adapter still parses current upstream data.
 * Asserts shape only — prices drift over time.
 *
 * Run locally: RUN_INTEGRATION=1 npx vitest run test/integration/aws-pricing.smoke.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { PricingCache } from "../../src/pricing/cache.js";
import { AwsBulkLoader } from "../../src/pricing/aws/bulk-loader.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("AWS pricing smoke", () => {
  const dbDir = join(tmpdir(), `cloudcost-smoke-aws-${Date.now()}`);
  const dbPath = join(dbDir, "cache.db");
  const cache = new PricingCache(dbPath);
  const loader = new AwsBulkLoader(cache);

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("fetches a live EC2 price for t3.medium in us-east-1", async () => {
    const result = await loader.getComputePrice("t3.medium", "us-east-1", "Linux");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      price_per_unit: expect.any(Number),
      currency: expect.any(String),
      provider: "aws",
      region: "us-east-1",
    });
    expect(result!.price_per_unit).toBeGreaterThan(0);
    expect(result!.price_per_unit).toBeLessThan(10);
  }, 60_000);
});
