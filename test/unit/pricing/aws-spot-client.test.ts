import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { AwsSpotClient } from "../../../src/pricing/aws/spot-client.js";

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-aws-spot-test-${suffix}`, "cache.db");
}

const SAMPLE_DOC = {
  spot_advisor: {
    "us-east-1": {
      Linux: {
        "t3.large": { s: 65, r: 2 },
        "c5.xlarge": { s: 70, r: 1 },
        "r5.large": { s: 60, r: 3 },
      },
      Windows: {
        "t3.large": { s: 40, r: 2 },
      },
    },
    "us-west-2": {
      Linux: {
        "m5.xlarge": { s: 72, r: 1 },
      },
    },
  },
};

describe("AwsSpotClient", () => {
  let dbPath: string;
  let cache: PricingCache;
  let client: AwsSpotClient;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    client = new AwsSpotClient(cache);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it("returns Linux spot factor for a known instance/region", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => SAMPLE_DOC,
      })),
    );

    const factor = await client.getSpotFactor("t3.large", "us-east-1", "Linux");
    // s=65 → factor = 0.35
    expect(factor).not.toBeNull();
    expect(factor!).toBeCloseTo(0.35, 5);
  });

  it("returns Windows spot factor when requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_DOC })),
    );

    const factor = await client.getSpotFactor("t3.large", "us-east-1", "Windows");
    // s=40 → factor = 0.60
    expect(factor).toBeCloseTo(0.6, 5);
  });

  it("returns null when instance is unknown in the region", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_DOC })),
    );

    const factor = await client.getSpotFactor("zz9.garbage", "us-east-1", "Linux");
    expect(factor).toBeNull();
  });

  it("returns null when region is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_DOC })),
    );

    const factor = await client.getSpotFactor("t3.large", "ap-mars-1", "Linux");
    expect(factor).toBeNull();
  });

  it("returns null on network failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const factor = await client.getSpotFactor("t3.large", "us-east-1");
    expect(factor).toBeNull();
  });

  it("returns null on non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );

    const factor = await client.getSpotFactor("t3.large", "us-east-1");
    expect(factor).toBeNull();
  });

  it("caches the document so a second lookup does not refetch", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => SAMPLE_DOC,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await client.getSpotFactor("t3.large", "us-east-1");
    const b = await client.getSpotFactor("c5.xlarge", "us-east-1");

    expect(a).toBeCloseTo(0.35, 5);
    expect(b).toBeCloseTo(0.3, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clamps absurd savings values into the sane range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          spot_advisor: {
            "us-east-1": { Linux: { "weird.large": { s: 200, r: 1 } } },
          },
        }),
      })),
    );

    const factor = await client.getSpotFactor("weird.large", "us-east-1");
    // s is clamped to 95 → factor = 0.05
    expect(factor).toBeCloseTo(0.05, 5);
  });
});
