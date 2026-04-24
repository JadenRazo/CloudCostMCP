import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { CloudProvider } from "../../../src/types/resources.js";
import { tempDbPath } from "../../helpers/factories.js";

describe("PricingEngine", () => {
  let dbPath: string;
  let cache: PricingCache;
  let engine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-engine-test");
    cache = new PricingCache(dbPath);
    engine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  describe("getProvider", () => {
    it("returns a provider for aws", () => {
      const provider = engine.getProvider("aws");
      expect(provider).toBeDefined();
      expect(typeof provider.getComputePrice).toBe("function");
    });

    it("returns a provider for azure", () => {
      const provider = engine.getProvider("azure");
      expect(provider).toBeDefined();
    });

    it("returns a provider for gcp", () => {
      const provider = engine.getProvider("gcp");
      expect(provider).toBeDefined();
    });

    it("throws for unknown provider", () => {
      expect(() => engine.getProvider("oracle" as CloudProvider)).toThrow("Unknown cloud provider");
    });
  });

  describe("getPrice routing", () => {
    it("routes compute service aliases correctly and returns a fallback price", async () => {
      for (const svc of ["compute", "ec2", "vm", "instance", "virtual-machines"]) {
        const result = await engine.getPrice("aws", svc, "t3.large", "us-east-1");
        expect(result).not.toBeNull();
        expect(result!.price_per_unit).toBeTypeOf("number");
        // t3.large fallback is $0.0832/hr; allow some tolerance for region multiplier
        expect(result!.price_per_unit).toBeGreaterThanOrEqual(0.05);
        expect(result!.price_per_unit).toBeLessThanOrEqual(0.2);
        expect(result!.provider).toBe("aws");
      }
    });

    it("routes database service aliases correctly and returns a fallback price", async () => {
      for (const svc of ["database", "rds", "sql", "db"]) {
        const result = await engine.getPrice("aws", svc, "db.t3.medium", "us-east-1");
        expect(result).not.toBeNull();
        expect(result!.price_per_unit).toBeTypeOf("number");
        // db.t3.medium fallback is $0.072/hr
        expect(result!.price_per_unit).toBeGreaterThanOrEqual(0.04);
        expect(result!.price_per_unit).toBeLessThanOrEqual(0.15);
        expect(result!.provider).toBe("aws");
      }
    });

    it("routes storage service aliases correctly and returns a fallback price", async () => {
      for (const svc of ["storage", "ebs", "disk"]) {
        const result = await engine.getPrice("aws", svc, "gp3", "us-east-1");
        expect(result).not.toBeNull();
        expect(result!.price_per_unit).toBeTypeOf("number");
        // gp3 fallback is $0.08/GB-mo
        expect(result!.price_per_unit).toBeGreaterThanOrEqual(0.04);
        expect(result!.price_per_unit).toBeLessThanOrEqual(0.2);
        expect(result!.provider).toBe("aws");
      }
    });

    it("routes kubernetes service aliases correctly", async () => {
      for (const svc of ["k8s", "kubernetes", "eks"]) {
        const result = await engine.getPrice("aws", svc, "", "us-east-1");
        expect(result).not.toBeNull();
        expect(result!.price_per_unit).toBeTypeOf("number");
        expect(result!.price_per_unit).toBeGreaterThan(0);
      }
    });

    it("routes nat-gateway service correctly", async () => {
      const result = await engine.getPrice("aws", "nat-gateway", "", "us-east-1");
      expect(result).not.toBeNull();
      expect(result!.price_per_unit).toBeTypeOf("number");
      expect(result!.price_per_unit).toBeGreaterThan(0);
    });

    it("routes load-balancer service correctly", async () => {
      const result = await engine.getPrice("aws", "load-balancer", "application", "us-east-1");
      expect(result).not.toBeNull();
      expect(result!.price_per_unit).toBeTypeOf("number");
      expect(result!.price_per_unit).toBeGreaterThan(0);
    });

    it("returns null for unrecognised service", async () => {
      const result = await engine.getPrice("aws", "quantum-computing", "q1.large", "us-east-1");
      expect(result).toBeNull();
    });

    it("passes attributes.os to compute price", async () => {
      const result = await engine.getPrice("aws", "compute", "t3.large", "us-east-1", {
        os: "Windows",
      });
      expect(result).not.toBeNull();
      expect(result!.price_per_unit).toBeTypeOf("number");
      expect(result!.price_per_unit).toBeGreaterThan(0);
    });

    it("passes attributes.engine to database price", async () => {
      const result = await engine.getPrice("aws", "database", "db.t3.medium", "us-east-1", {
        engine: "postgres",
      });
      expect(result).not.toBeNull();
      expect(result!.price_per_unit).toBeTypeOf("number");
      expect(result!.price_per_unit).toBeGreaterThan(0);
    });
  });

  describe("GCP bundled pricing", () => {
    it("returns a non-null bundled price for e2-standard-2", async () => {
      const result = await engine.getPrice("gcp", "compute", "e2-standard-2", "us-central1");
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("gcp");
      expect(result!.price_per_unit).toBeTypeOf("number");
      // Bundled price is $0.067/hr; allow tolerance for data updates
      expect(result!.price_per_unit).toBeGreaterThanOrEqual(0.03);
      expect(result!.price_per_unit).toBeLessThanOrEqual(0.15);
    });

    it("returns a price in a reasonable range for compute instances", async () => {
      const result = await engine.getPrice("gcp", "compute", "e2-standard-2", "us-central1");
      expect(result).not.toBeNull();
      // Any compute hourly price should be between $0.001 and $10.00/hr
      expect(result!.price_per_unit).toBeGreaterThanOrEqual(0.001);
      expect(result!.price_per_unit).toBeLessThanOrEqual(10.0);
    });
  });

  describe("fallback price determinism", () => {
    it("returns the same AWS compute fallback price on repeated calls", async () => {
      const first = await engine.getPrice("aws", "compute", "t3.large", "us-east-1");
      const second = await engine.getPrice("aws", "compute", "t3.large", "us-east-1");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.price_per_unit).toBe(second!.price_per_unit);
    });

    it("returns the same AWS database fallback price on repeated calls", async () => {
      const first = await engine.getPrice("aws", "database", "db.t3.medium", "us-east-1");
      const second = await engine.getPrice("aws", "database", "db.t3.medium", "us-east-1");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.price_per_unit).toBe(second!.price_per_unit);
    });

    it("returns the same AWS storage fallback price on repeated calls", async () => {
      const first = await engine.getPrice("aws", "storage", "gp3", "us-east-1");
      const second = await engine.getPrice("aws", "storage", "gp3", "us-east-1");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.price_per_unit).toBe(second!.price_per_unit);
    });
  });
});
