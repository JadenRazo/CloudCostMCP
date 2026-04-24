/**
 * GCP pricing smoke test.
 *
 * Gated behind RUN_INTEGRATION=1. The Cloud Billing Catalog API is public
 * but rate-limited; it does not require an API key for unauthenticated
 * SKU listings. Asserts shape only — prices drift over time.
 *
 * Run locally: RUN_INTEGRATION=1 npx vitest run test/integration/gcp-pricing.smoke.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { PricingCache } from "../../src/pricing/cache.js";
import { CloudBillingClient } from "../../src/pricing/gcp/cloud-billing-client.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("GCP pricing smoke", () => {
  const dbDir = join(tmpdir(), `cloudcost-smoke-gcp-${Date.now()}`);
  const dbPath = join(dbDir, "cache.db");
  const cache = new PricingCache(dbPath);
  const client = new CloudBillingClient(cache);

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("fetches a live Compute Engine price for e2-standard-2 in us-central1", async (ctx) => {
    const result = await client.fetchComputeSkus("e2-standard-2", "us-central1");

    // GCP catalog occasionally returns no match for a machine family on
    // a region — skip so CI dashboards show this as a skip, not a false pass.
    if (result === null) {
      console.warn("GCP compute SKU not found — upstream catalog miss, not an adapter failure");
      ctx.skip();
      return;
    }

    expect(result).toMatchObject({
      price_per_unit: expect.any(Number),
      currency: expect.any(String),
      provider: "gcp",
    });
    expect(result.price_per_unit).toBeGreaterThan(0);
    expect(result.price_per_unit).toBeLessThan(10);
  }, 60_000);
});
