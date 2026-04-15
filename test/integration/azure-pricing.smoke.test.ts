/**
 * Azure pricing smoke test.
 *
 * Gated behind RUN_INTEGRATION=1. Makes one live request to the Azure
 * Retail Prices API to verify the adapter still parses current upstream
 * data. Asserts shape only — prices drift over time.
 *
 * Run locally: RUN_INTEGRATION=1 npx vitest run test/integration/azure-pricing.smoke.test.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { PricingCache } from "../../src/pricing/cache.js";
import { AzureRetailClient } from "../../src/pricing/azure/retail-client.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("Azure pricing smoke", () => {
  const dbDir = join(tmpdir(), `cloudcost-smoke-azure-${Date.now()}`);
  const dbPath = join(dbDir, "cache.db");
  const cache = new PricingCache(dbPath);
  const client = new AzureRetailClient(cache);

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("fetches a live VM price for Standard_D2s_v3 in eastus", async () => {
    const result = await client.getComputePrice("Standard_D2s_v3", "eastus", "linux");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      price_per_unit: expect.any(Number),
      currency: expect.any(String),
      provider: "azure",
    });
    expect(result!.price_per_unit).toBeGreaterThan(0);
    expect(result!.price_per_unit).toBeLessThan(10);
  }, 60_000);
});
