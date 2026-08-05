import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { AwsSpotClient } from "../../../src/pricing/aws/spot-client.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { CloudCostConfig } from "../../../src/types/config.js";

/**
 * Regression guard: CLOUDCOST_CACHE_TTL / config.cache.ttl_seconds used to be
 * parsed but never read — every cache write hardcoded the 24h CACHE_TTL
 * constant. These tests prove a custom TTL threads from the config through
 * PricingEngine → provider adapters → client cache.set calls.
 */

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-cache-ttl-test-${suffix}`, "cache.db");
}

const SAMPLE_SPOT_DOC = {
  spot_advisor: {
    "us-east-1": {
      Linux: {
        "t3.large": { s: 65, r: 2 },
      },
    },
  },
};

function makeConfig(dbPath: string, ttlSeconds: number): CloudCostConfig {
  return {
    ...DEFAULT_CONFIG,
    cache: { ...DEFAULT_CONFIG.cache, db_path: dbPath, ttl_seconds: ttlSeconds },
  };
}

describe("configured cache TTL reaches cache.set", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => SAMPLE_SPOT_DOC,
      })),
    );
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it("AwsSpotClient passes its constructor TTL to cache.set", async () => {
    const setSpy = vi.spyOn(cache, "set");
    const client = new AwsSpotClient(cache, 1234);

    await client.getSpotFactor("t3.large", "us-east-1", "Linux");

    expect(setSpy).toHaveBeenCalled();
    const ttlArg = setSpy.mock.calls[0]![5];
    expect(ttlArg).toBe(1234);
  });

  it("AwsSpotClient defaults to the 24h TTL when none is provided", async () => {
    const setSpy = vi.spyOn(cache, "set");
    const client = new AwsSpotClient(cache);

    await client.getSpotFactor("t3.large", "us-east-1", "Linux");

    expect(setSpy).toHaveBeenCalled();
    expect(setSpy.mock.calls[0]![5]).toBe(86400);
  });

  it("PricingEngine threads config.cache.ttl_seconds through to provider cache writes", async () => {
    const setSpy = vi.spyOn(cache, "set");
    const engine = new PricingEngine(cache, makeConfig(dbPath, 4321));

    const provider = engine.getProvider("aws");
    const factor = await provider.getSpotFactor?.("t3.large", "us-east-1", "Linux");

    expect(factor).not.toBeNull();
    expect(setSpy).toHaveBeenCalled();
    expect(setSpy.mock.calls[0]![5]).toBe(4321);
  });
});
