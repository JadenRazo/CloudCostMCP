import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { calculateDatabaseCost } from "../../../src/calculator/database.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { makeResource, tempDbPath } from "../../helpers/factories.js";

describe("calculateDatabaseCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath("cloudcost-db-test");
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("calculates cost for an AWS RDS db.t3.medium instance", async () => {
    const resource = makeResource({
      type: "aws_db_instance",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 100,
      },
    });

    const estimate = await calculateDatabaseCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.provider).toBe("aws");
    expect(estimate.breakdown.length).toBeGreaterThan(0);
  });

  it("doubles instance cost for multi-AZ deployments", async () => {
    const single = makeResource({
      id: "db-single",
      type: "aws_db_instance",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        multi_az: false,
      },
    });

    const multi = makeResource({
      id: "db-multi",
      type: "aws_db_instance",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        multi_az: true,
      },
    });

    const singleEst = await calculateDatabaseCost(single, "aws", "us-east-1", pricingEngine);
    const multiEst = await calculateDatabaseCost(multi, "aws", "us-east-1", pricingEngine);

    expect(multiEst.monthly_cost).toBeGreaterThan(singleEst.monthly_cost);
    if (singleEst.monthly_cost > 0) {
      expect(multiEst.monthly_cost).toBeCloseTo(singleEst.monthly_cost * 2, 0);
    }
  });

  it("includes allocated storage cost", async () => {
    const noStorage = makeResource({
      id: "db-no-storage",
      type: "aws_db_instance",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 0,
      },
    });

    const withStorage = makeResource({
      id: "db-with-storage",
      type: "aws_db_instance",
      attributes: {
        instance_class: "db.t3.medium",
        engine: "mysql",
        allocated_storage: 200,
      },
    });

    const noStorageEst = await calculateDatabaseCost(noStorage, "aws", "us-east-1", pricingEngine);
    const withStorageEst = await calculateDatabaseCost(
      withStorage,
      "aws",
      "us-east-1",
      pricingEngine,
    );

    expect(withStorageEst.monthly_cost).toBeGreaterThan(noStorageEst.monthly_cost);
  });

  it("returns low confidence when no mapping is found", async () => {
    const resource = makeResource({
      type: "aws_db_instance",
      attributes: { instance_class: "" },
    });

    const estimate = await calculateDatabaseCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.confidence).toBe("low");
  });

  it("uses tier attribute for GCP Cloud SQL", async () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_sql_database_instance",
      attributes: { tier: "db-custom-2-7680" },
    });

    const estimate = await calculateDatabaseCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.provider).toBe("gcp");
  });

  it("uses vm_size attribute for Azure database resources", async () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_postgresql_flexible_server",
      attributes: { vm_size: "GP_Standard_D2s_v3" },
    });

    const estimate = await calculateDatabaseCost(resource, "azure", "eastus", pricingEngine);

    expect(estimate.provider).toBe("azure");
  });
});
