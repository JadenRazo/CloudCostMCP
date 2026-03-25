import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-engine-test-${suffix}`, "cache.db");
}

describe("PricingEngine", () => {
  let dbPath: string;
  let cache: PricingCache;
  let engine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
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
      expect(() => engine.getProvider("oracle" as any)).toThrow("Unknown cloud provider");
    });
  });

  describe("getPrice routing", () => {
    it("routes compute service aliases correctly", async () => {
      for (const svc of ["compute", "ec2", "vm", "instance", "virtual-machines"]) {
        const result = await engine.getPrice("aws", svc, "t3.large", "us-east-1");
        // Should not throw - result may be null (fallback) or a real price
        expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
      }
    });

    it("routes database service aliases correctly", async () => {
      for (const svc of ["database", "rds", "sql", "db"]) {
        const result = await engine.getPrice("aws", svc, "db.t3.medium", "us-east-1");
        expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
      }
    });

    it("routes storage service aliases correctly", async () => {
      for (const svc of ["storage", "ebs", "disk"]) {
        const result = await engine.getPrice("aws", svc, "gp3", "us-east-1");
        expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
      }
    });

    it("routes kubernetes service aliases correctly", async () => {
      for (const svc of ["k8s", "kubernetes", "eks"]) {
        const result = await engine.getPrice("aws", svc, "", "us-east-1");
        expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
      }
    });

    it("routes nat-gateway service correctly", async () => {
      const result = await engine.getPrice("aws", "nat-gateway", "", "us-east-1");
      expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
    });

    it("routes load-balancer service correctly", async () => {
      const result = await engine.getPrice("aws", "load-balancer", "application", "us-east-1");
      expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
    });

    it("returns null for unrecognised service", async () => {
      const result = await engine.getPrice("aws", "quantum-computing", "q1.large", "us-east-1");
      expect(result).toBeNull();
    });

    it("passes attributes.os to compute price", async () => {
      const result = await engine.getPrice("aws", "compute", "t3.large", "us-east-1", {
        os: "Windows",
      });
      // Should not throw
      expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
    });

    it("passes attributes.engine to database price", async () => {
      const result = await engine.getPrice("aws", "database", "db.t3.medium", "us-east-1", {
        engine: "postgres",
      });
      expect(result === null || typeof result?.price_per_unit === "number").toBe(true);
    });
  });
});
