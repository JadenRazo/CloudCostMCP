import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { getPricing } from "../../../src/tools/get-pricing.js";
import { tempDbPath } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("getPricing", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-getpricing-test");
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
  // Happy path — AWS compute
  // -------------------------------------------------------------------------

  it("returns a price object for a known AWS instance type", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "compute",
        resource_type: "t3.micro",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    // The handler always returns { price: ... }.
    expect(result).toHaveProperty("price");
    // A known instance type should resolve to a non-null price.
    expect(result.price).not.toBeNull();
  });

  it("returned price object has price_per_unit and currency fields", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "compute",
        resource_type: "t3.small",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    const price = result.price as Record<string, unknown>;
    expect(typeof price.price_per_unit).toBe("number");
    expect(price.price_per_unit as number).toBeGreaterThan(0);
    expect(typeof price.currency).toBe("string");
  });

  it("t3.small costs more per hour than t3.micro", async () => {
    const microResult = (await getPricing(
      { provider: "aws", service: "compute", resource_type: "t3.micro", region: "us-east-1" },
      pricingEngine,
    )) as Record<string, unknown>;

    const smallResult = (await getPricing(
      { provider: "aws", service: "compute", resource_type: "t3.small", region: "us-east-1" },
      pricingEngine,
    )) as Record<string, unknown>;

    const microPrice = (microResult.price as Record<string, unknown>).price_per_unit as number;
    const smallPrice = (smallResult.price as Record<string, unknown>).price_per_unit as number;
    expect(smallPrice).toBeGreaterThan(microPrice);
  });

  // -------------------------------------------------------------------------
  // Storage pricing
  // -------------------------------------------------------------------------

  it("returns a price for AWS gp3 storage", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "storage",
        resource_type: "gp3",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
    // gp3 is a well-known EBS type and should have bundled fallback pricing.
    if (result.price !== null) {
      const price = result.price as Record<string, unknown>;
      expect(typeof price.price_per_unit).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // Provider variations
  // -------------------------------------------------------------------------

  it("returns a price for a GCP machine type using bundled pricing", async () => {
    const result = (await getPricing(
      {
        provider: "gcp",
        service: "compute",
        resource_type: "e2-standard-2",
        region: "us-central1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
    // GCP compute uses bundled pricing so the result should not be null.
    expect(result.price).not.toBeNull();
    const price = result.price as Record<string, unknown>;
    expect(typeof price.price_per_unit).toBe("number");
    expect(price.price_per_unit as number).toBeGreaterThan(0);
  });

  it("returns a price for an Azure VM size", async () => {
    const result = (await getPricing(
      {
        provider: "azure",
        service: "compute",
        resource_type: "Standard_D2s_v3",
        region: "eastus",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
    // Azure uses retail API; with fetch disabled it may return null via fallback
    // or a bundled price — in both cases the shape must be correct.
    if (result.price !== null) {
      const price = result.price as Record<string, unknown>;
      expect(typeof price.price_per_unit).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // Service enum mapping
  // -------------------------------------------------------------------------

  it("maps nat_gateway service to internal nat-gateway identifier without throwing", async () => {
    // This exercises the serviceMap translation inside the handler.
    const result = (await getPricing(
      {
        provider: "aws",
        service: "nat_gateway",
        resource_type: "nat-gateway",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
  });

  it("maps network service to nat-gateway without throwing", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "network",
        resource_type: "nat-gateway",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
  });

  it("maps load_balancer service without throwing", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "load_balancer",
        resource_type: "application",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
  });

  // -------------------------------------------------------------------------
  // Unknown resource type — graceful null
  // -------------------------------------------------------------------------

  it("returns null price for an unrecognised resource type", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "compute",
        resource_type: "totally-fake-instance-type-xyz",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
    expect(result.price).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Verbose fields are stripped
  // -------------------------------------------------------------------------

  it("price object does not include a description field", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "compute",
        resource_type: "t3.medium",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    if (result.price !== null) {
      const price = result.price as Record<string, unknown>;
      expect(price).not.toHaveProperty("description");
    }
  });

  // -------------------------------------------------------------------------
  // Database service
  // -------------------------------------------------------------------------

  it("returns a price for an AWS RDS instance type", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "database",
        resource_type: "db.t3.medium",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("price");
    if (result.price !== null) {
      const price = result.price as Record<string, unknown>;
      expect(typeof price.price_per_unit).toBe("number");
      expect(price.price_per_unit as number).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Backward-compatibility: fallback_metadata shape lock
  //
  // get_pricing has shipped this exact shape (flat keys:
  // last_updated, source, sku_count, refresh_script_version) since 1.0.x.
  // Downstream consumers parse it with fixed-key assumptions; the shared
  // FallbackMetadataSummary refactor must not drift the single-provider
  // output from this schema.
  // -------------------------------------------------------------------------

  it("fallback_metadata keeps its historic flat shape for single-provider calls", async () => {
    const result = (await getPricing(
      {
        provider: "aws",
        service: "compute",
        resource_type: "t3.micro",
        region: "us-east-1",
      },
      pricingEngine,
    )) as Record<string, unknown>;

    // When metadata.json exists for the provider, the response must include
    // fallback_metadata at the top level with these exact keys.
    if (result.fallback_metadata !== undefined) {
      const meta = result.fallback_metadata as Record<string, unknown>;
      const keys = Object.keys(meta).sort();
      expect(keys).toEqual(
        ["last_updated", "refresh_script_version", "sku_count", "source"].sort(),
      );
      expect(typeof meta.last_updated).toBe("string");
      expect(typeof meta.source).toBe("string");
      expect(typeof meta.sku_count).toBe("number");
      expect(typeof meta.refresh_script_version).toBe("string");
    }
  });
});
