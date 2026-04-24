import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

import { PricingCache } from "../../src/pricing/cache.js";
import { PricingEngine } from "../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { CloudCostConfig } from "../../src/types/config.js";

import { analyzeTerraform } from "../../src/tools/analyze-terraform.js";
import { estimateCost } from "../../src/tools/estimate-cost.js";
import { compareProviders } from "../../src/tools/compare-providers.js";
import { getEquivalents } from "../../src/tools/get-equivalents.js";
import { getPricing } from "../../src/tools/get-pricing.js";
import { optimizeCost } from "../../src/tools/optimize-cost.js";
import { tempDbPath } from "../helpers/factories.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixtureFile(fixture: string, filename: string): { path: string; content: string } {
  const filePath = join("test", "fixtures", fixture, filename);
  return {
    path: filePath,
    content: readFileSync(filePath, "utf-8"),
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let dbPath: string;
let cache: PricingCache | undefined;
let pricingEngine: PricingEngine;
let config: CloudCostConfig;

beforeAll(() => {
  dbPath = tempDbPath("cloudcost-e2e");
  config = {
    ...DEFAULT_CONFIG,
    cache: { ...DEFAULT_CONFIG.cache, db_path: dbPath },
  };
  try {
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, config);
  } catch (err) {
    // Ensure partial state doesn't leak to afterAll; rethrow to fail setup.
    cache?.close();
    cache = undefined;
    throw err;
  }
});

afterAll(() => {
  cache?.close();
  if (dbPath) {
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("End-to-end tool functions", () => {
  // -----------------------------------------------------------------------
  // analyzeTerraform
  // -----------------------------------------------------------------------
  describe("analyzeTerraform", () => {
    it("parses simple-ec2 fixture and returns a resource inventory", async () => {
      const files = [
        fixtureFile("simple-ec2", "main.tf"),
        fixtureFile("simple-ec2", "variables.tf"),
      ];

      const result = await analyzeTerraform({ files });

      expect(result).toBeDefined();
      const inventory = result as {
        resources: unknown[];
        by_type: Record<string, number>;
        provider: string;
      };

      expect(inventory.resources).toHaveLength(2);
      // Both resources should be aws_instance
      expect(inventory.by_type["aws_instance"]).toBe(2);
      expect(inventory.provider).toBe("aws");
    });

    it("includes parse warnings array in the result", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await analyzeTerraform({ files })) as { parse_warnings: string[] };
      expect(Array.isArray(result.parse_warnings)).toBe(true);
    });

    it("applies tfvars overrides to variable-interpolated values", async () => {
      const files = [
        fixtureFile("full-stack", "main.tf"),
        fixtureFile("full-stack", "variables.tf"),
      ];
      const tfvars = fixtureFile("full-stack", "terraform.tfvars").content;

      const result = (await analyzeTerraform({ files, tfvars })) as {
        resources: Array<{ attributes: { instance_type?: string } }>;
      };

      // terraform.tfvars sets instance_type = "t3.xlarge"
      const appInstance = result.resources.find(
        (r) => (r.attributes.instance_type as string | undefined) === "t3.xlarge",
      );
      expect(appInstance).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // estimateCost
  // -----------------------------------------------------------------------
  describe("estimateCost", () => {
    it("calculates costs for the full-stack fixture on AWS", async () => {
      const files = [
        fixtureFile("full-stack", "main.tf"),
        fixtureFile("full-stack", "variables.tf"),
      ];
      const tfvars = fixtureFile("full-stack", "terraform.tfvars").content;

      const result = await estimateCost({ files, tfvars, provider: "aws" }, pricingEngine, config);

      const breakdown = result as {
        provider: string;
        total_monthly: number;
        total_yearly: number;
        by_resource: unknown[];
        currency: string;
      };

      expect(breakdown.provider).toBe("aws");
      expect(breakdown.currency).toBe("USD");
      // There are 5 resources in the full-stack fixture; at least a non-empty
      // by_resource list is expected.
      expect(breakdown.by_resource.length).toBeGreaterThan(0);
      // Total monthly cost should be non-negative; fallback/static data may
      // return 0 for some resources but the field must be present.
      expect(typeof breakdown.total_monthly).toBe("number");
      expect(breakdown.total_monthly).toBeGreaterThanOrEqual(0);
      // total_yearly is calculated independently by the cost engine
      // (summing per-resource yearly costs), so it should be close to
      // total_monthly * 12 but may differ slightly due to per-resource rounding.
      expect(breakdown.total_yearly).toBeCloseTo(breakdown.total_monthly * 12, 0);
    });

    it("respects an explicit region override", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];

      const result = (await estimateCost(
        { files, provider: "aws", region: "eu-west-1" },
        pricingEngine,
        config,
      )) as { region: string };

      expect(result.region).toBe("eu-west-1");
    });

    it("accepts azure as a target provider", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await estimateCost({ files, provider: "azure" }, pricingEngine, config)) as {
        provider: string;
      };
      expect(result.provider).toBe("azure");
    });
  });

  // -----------------------------------------------------------------------
  // compareProviders
  // -----------------------------------------------------------------------
  describe("compareProviders", () => {
    it("generates a markdown report for the simple-ec2 fixture", async () => {
      const files = [
        fixtureFile("simple-ec2", "main.tf"),
        fixtureFile("simple-ec2", "variables.tf"),
      ];

      const result = (await compareProviders(
        { files, format: "markdown", providers: ["aws", "azure", "gcp"] },
        pricingEngine,
        config,
      )) as { report: string; format: string; comparison: { providers: unknown[] } };

      expect(result.format).toBe("markdown");
      // Markdown report should contain a table header
      expect(result.report).toContain("| Provider |");
      expect(result.report).toContain("# Cloud Cost Comparison Report");
      // All three providers should be present in the lightweight summary
      expect(result.comparison.providers).toHaveLength(3);
    });

    it("generates a json report", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await compareProviders(
        { files, format: "json", providers: ["aws", "azure", "gcp"] },
        pricingEngine,
        config,
      )) as { report: string; format: string };

      expect(result.format).toBe("json");
      // Should be valid JSON
      const parsed = JSON.parse(result.report);
      expect(parsed).toBeDefined();
      expect(parsed.comparisons).toBeDefined();
    });

    it("generates a csv report", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await compareProviders(
        { files, format: "csv", providers: ["aws", "azure", "gcp"] },
        pricingEngine,
        config,
      )) as { report: string; format: string };

      expect(result.format).toBe("csv");
      expect(result.report).toContain(
        "Resource,Type,AWS Monthly,Azure Monthly,GCP Monthly,Cheapest",
      );
    });

    it("limits comparison to a subset of providers", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await compareProviders(
        { files, format: "markdown", providers: ["aws", "gcp"] },
        pricingEngine,
        config,
      )) as { comparison: { providers: Array<{ provider: string }> } };

      expect(result.comparison.providers).toHaveLength(2);
      const providers = result.comparison.providers.map((c) => c.provider);
      expect(providers).toContain("aws");
      expect(providers).toContain("gcp");
      expect(providers).not.toContain("azure");
    });
  });

  // -----------------------------------------------------------------------
  // getEquivalents
  // -----------------------------------------------------------------------
  describe("getEquivalents", () => {
    it("returns cross-provider mappings for aws_instance", async () => {
      const result = (await getEquivalents({
        resource_type: "aws_instance",
        source_provider: "aws",
      })) as {
        resource_equivalents: Record<string, string | null>;
      };

      expect(result.resource_equivalents).toBeDefined();
      // Azure and GCP equivalents should be present (non-null entries only).
      expect(Object.keys(result.resource_equivalents).length).toBeGreaterThan(0);
    });

    it("returns only the requested target provider when specified", async () => {
      const result = (await getEquivalents({
        resource_type: "aws_instance",
        source_provider: "aws",
        target_provider: "gcp",
      })) as { resource_equivalents: Record<string, unknown> };

      const keys = Object.keys(result.resource_equivalents);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe("gcp");
    });

    it("includes instance equivalents when instance_type is provided", async () => {
      const result = (await getEquivalents({
        resource_type: "aws_instance",
        source_provider: "aws",
        instance_type: "t3.large",
      })) as {
        instance_type: string;
        instance_equivalents: Record<string, string | null>;
      };

      expect(result.instance_type).toBe("t3.large");
      expect(result.instance_equivalents).toBeDefined();
      // Should include at least azure and gcp entries
      expect(Object.keys(result.instance_equivalents).length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // getPricing
  // -----------------------------------------------------------------------
  describe("getPricing", () => {
    it("returns a pricing result structure for t3.large on AWS", async () => {
      const result = (await getPricing(
        {
          provider: "aws",
          service: "compute",
          resource_type: "t3.large",
          region: "us-east-1",
        },
        pricingEngine,
      )) as {
        price: {
          price_per_unit: number;
          provider: string;
          service: string;
          resource_type: string;
          region: string;
        } | null;
      };

      // price may be null when live API is unavailable but the field must exist
      expect("price" in result).toBe(true);
      if (result.price !== null) {
        expect(typeof result.price.price_per_unit).toBe("number");
        expect(result.price.price_per_unit).toBeGreaterThanOrEqual(0);
        // The price object carries provider/resource_type/region from the
        // NormalizedPrice struct; service is the internal identifier.
        expect(result.price.provider).toBe("aws");
        expect(result.price.resource_type).toBe("t3.large");
        expect(result.price.region).toBe("us-east-1");
      }
    });

    it("returns a result for storage pricing", async () => {
      const result = (await getPricing(
        {
          provider: "aws",
          service: "storage",
          resource_type: "gp3",
          region: "us-east-1",
        },
        pricingEngine,
      )) as { price: unknown };

      expect("price" in result).toBe(true);
    });

    it("handles kubernetes service type", async () => {
      const result = (await getPricing(
        {
          provider: "aws",
          service: "kubernetes",
          resource_type: "eks",
          region: "us-east-1",
        },
        pricingEngine,
      )) as { price: { service: string } | null };

      expect("price" in result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // optimizeCost
  // -----------------------------------------------------------------------
  describe("optimizeCost", () => {
    it("returns optimisation recommendations for the full-stack fixture", async () => {
      const files = [
        fixtureFile("full-stack", "main.tf"),
        fixtureFile("full-stack", "variables.tf"),
      ];
      const tfvars = fixtureFile("full-stack", "terraform.tfvars").content;

      const result = (await optimizeCost(
        { files, tfvars, providers: ["aws", "azure", "gcp"] },
        pricingEngine,
        config,
      )) as {
        recommendations: Array<{ type: string; monthly_savings: number }>;
        reserved_pricing: unknown[];
        total_potential_savings: number;
      };

      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(Array.isArray(result.reserved_pricing)).toBe(true);
      expect(typeof result.total_potential_savings).toBe("number");
    });

    it("returns non-negative total_potential_savings", async () => {
      const files = [fixtureFile("simple-ec2", "main.tf")];
      const result = (await optimizeCost({ files, providers: ["aws"] }, pricingEngine, config)) as {
        total_potential_savings: number;
      };

      expect(result.total_potential_savings).toBeGreaterThanOrEqual(0);
    });

    it("each recommendation has the required fields", async () => {
      const files = [
        fixtureFile("full-stack", "main.tf"),
        fixtureFile("full-stack", "variables.tf"),
      ];

      const result = (await optimizeCost({ files, providers: ["aws"] }, pricingEngine, config)) as {
        recommendations: Array<Record<string, unknown>>;
      };

      for (const rec of result.recommendations) {
        expect(typeof rec.resource_id).toBe("string");
        expect(typeof rec.resource_name).toBe("string");
        expect(typeof rec.type).toBe("string");
        expect(typeof rec.description).toBe("string");
        expect(typeof rec.monthly_savings).toBe("number");
        expect(typeof rec.percentage_savings).toBe("number");
        expect(["high", "medium", "low"]).toContain(rec.confidence);
      }
    });
  });
});
