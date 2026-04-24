import { describe, it, expect } from "vitest";
import {
  calculateAppServicePlanCost,
  calculateCosmosDbCost,
  calculateAzureFunctionCost,
  calculateCloudRunCost,
  calculateBigQueryCost,
  calculateGcpFunctionCost,
} from "../../../src/calculator/paas.js";
import { makeResource } from "../../helpers/factories.js";

// ---------------------------------------------------------------------------
// Azure App Service Plan
// ---------------------------------------------------------------------------

describe("calculateAppServicePlanCost", () => {
  it("returns $0 for free tier", () => {
    const resource = makeResource({
      type: "azurerm_app_service_plan",
      provider: "azure",
      attributes: { sku: "F1" },
    });
    const estimate = calculateAppServicePlanCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBe(0);
    expect(estimate.notes.some((n) => n.includes("free tier"))).toBe(true);
  });

  it("calculates B1 Basic pricing", () => {
    const resource = makeResource({
      type: "azurerm_app_service_plan",
      provider: "azure",
      attributes: { sku: "B1" },
    });
    const estimate = calculateAppServicePlanCost(resource, "azure", "eastus");

    // B1 = $0.075/hr * 730 = $54.75
    expect(estimate.monthly_cost).toBeCloseTo(0.075 * 730, 1);
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates P1v3 Premium pricing", () => {
    const resource = makeResource({
      type: "azurerm_app_service_plan",
      provider: "azure",
      attributes: { sku: "P1v3" },
    });
    const estimate = calculateAppServicePlanCost(resource, "azure", "eastus");

    // P1v3 = $0.175/hr * 730 = $127.75
    expect(estimate.monthly_cost).toBeCloseTo(0.175 * 730, 1);
  });

  it("falls back to sku_tier+sku_size when sku is absent", () => {
    const resource = makeResource({
      type: "azurerm_app_service_plan",
      provider: "azure",
      attributes: { sku_tier: "Basic", sku_size: "B1" },
    });
    const estimate = calculateAppServicePlanCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(0.075 * 730, 1);
  });
});

// ---------------------------------------------------------------------------
// Azure Cosmos DB
// ---------------------------------------------------------------------------

describe("calculateCosmosDbCost", () => {
  it("defaults to provisioned 400 RU/s", () => {
    const resource = makeResource({
      type: "azurerm_cosmosdb_account",
      attributes: { offer_type: "Standard" },
    });
    const estimate = calculateCosmosDbCost(resource, "azure", "eastus");

    // 400 RU/s / 100 * $0.008/hr * 730 + 1GB * $0.25 = $23.59
    const expectedProvisionedCost = (400 / 100) * 0.008 * 730;
    const expectedStorage = 1 * 0.25;
    expect(estimate.monthly_cost).toBeCloseTo(expectedProvisionedCost + expectedStorage, 1);
  });

  it("uses serverless pricing when EnableServerless capability present", () => {
    const resource = makeResource({
      type: "azurerm_cosmosdb_account",
      attributes: {
        offer_type: "Standard",
        capabilities: ["EnableServerless"],
      },
    });
    const estimate = calculateCosmosDbCost(resource, "azure", "eastus");

    // Serverless: 1M RU * $0.25/M = $0.25 + storage
    expect(estimate.monthly_cost).toBeCloseTo(0.25 + 0.25, 2);
  });

  it("uses provided throughput when specified", () => {
    const resource = makeResource({
      type: "azurerm_cosmosdb_account",
      attributes: { offer_type: "Standard", throughput: 1000 },
    });
    const estimate = calculateCosmosDbCost(resource, "azure", "eastus");

    const expectedProvisionedCost = (1000 / 100) * 0.008 * 730;
    expect(estimate.monthly_cost).toBeGreaterThan((400 / 100) * 0.008 * 730);
    expect(estimate.monthly_cost).toBeCloseTo(expectedProvisionedCost + 0.25, 1);
  });
});

// ---------------------------------------------------------------------------
// Azure Function App
// ---------------------------------------------------------------------------

describe("calculateAzureFunctionCost", () => {
  it("calculates consumption plan default cost", () => {
    const resource = makeResource({
      type: "azurerm_function_app",
      provider: "azure",
      attributes: {},
    });
    const estimate = calculateAzureFunctionCost(resource, "azure", "eastus");

    // Default: 1M executions * $0.20/M + GB-seconds
    // GB-seconds = 1_000_000 * 0.2 * (128/1024) = 25,000
    // compute = 25,000 * $0.000016 = $0.40
    // total ≈ $0.20 + $0.40 = $0.60
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.breakdown).toHaveLength(2);
  });

  it("includes default assumption note", () => {
    const resource = makeResource({ type: "azurerm_function_app" });
    const estimate = calculateAzureFunctionCost(resource, "azure", "eastus");

    expect(estimate.notes.some((n) => n.includes("Default assumption"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Google Cloud Run
// ---------------------------------------------------------------------------

describe("calculateCloudRunCost", () => {
  it("calculates cost with default assumptions", () => {
    const resource = makeResource({
      type: "google_cloud_run_service",
      provider: "gcp",
      region: "us-central1",
      attributes: {},
    });
    const estimate = calculateCloudRunCost(resource, "gcp", "us-central1");

    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.breakdown).toHaveLength(2);
    expect(estimate.confidence).toBe("medium");
  });

  it("parses milli-CPU format", () => {
    const milli = makeResource({
      type: "google_cloud_run_service",
      provider: "gcp",
      region: "us-central1",
      attributes: { cpu: "500m", memory: "256Mi" },
    });
    const full = makeResource({
      type: "google_cloud_run_service",
      provider: "gcp",
      region: "us-central1",
      attributes: { cpu: "1000m", memory: "256Mi" },
    });

    const milliEst = calculateCloudRunCost(milli, "gcp", "us-central1");
    const fullEst = calculateCloudRunCost(full, "gcp", "us-central1");

    // 500m = 0.5 vCPU; memory cost is the same for both, so total is not exactly half.
    // The CPU portion for 500m should be half of 1000m's CPU portion.
    // 500m CPU cost = 0.5 * 1_000_000 * 0.2 * 0.00002400 = $2.40
    // 1000m CPU cost = 1.0 * 1_000_000 * 0.2 * 0.00002400 = $4.80
    expect(milliEst.monthly_cost).toBeLessThan(fullEst.monthly_cost);
    // Specifically, the difference should equal the 0.5 vCPU cost
    const vcpuCostPerUnit = 1_000_000 * 0.2 * 0.000024; // 1 vCPU
    expect(fullEst.monthly_cost - milliEst.monthly_cost).toBeCloseTo(vcpuCostPerUnit * 0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// BigQuery
// ---------------------------------------------------------------------------

describe("calculateBigQueryCost", () => {
  it("calculates default 1TB/month queries + 10GB storage", () => {
    const resource = makeResource({
      type: "google_bigquery_dataset",
      provider: "gcp",
      region: "us-central1",
      attributes: {},
    });
    const estimate = calculateBigQueryCost(resource, "gcp", "us-central1");

    // 1TB * $5 + 10GB * $0.02 = $5.20
    expect(estimate.monthly_cost).toBeCloseTo(5.2, 2);
    expect(estimate.breakdown).toHaveLength(2);
  });

  it("scales linearly with query volume", () => {
    const r1 = makeResource({
      type: "google_bigquery_dataset",
      provider: "gcp",
      attributes: { monthly_query_tb: 1 },
    });
    const r10 = makeResource({
      type: "google_bigquery_dataset",
      provider: "gcp",
      attributes: { monthly_query_tb: 10 },
    });

    const e1 = calculateBigQueryCost(r1, "gcp", "us-central1");
    const e10 = calculateBigQueryCost(r10, "gcp", "us-central1");

    // Query cost: 1TB=$5, 10TB=$50. Storage same ($0.20 default).
    expect(e10.monthly_cost - e1.monthly_cost).toBeCloseTo(45, 1);
  });
});

// ---------------------------------------------------------------------------
// GCP Cloud Functions
// ---------------------------------------------------------------------------

describe("calculateGcpFunctionCost", () => {
  it("calculates default cost", () => {
    const resource = makeResource({
      type: "google_cloudfunctions_function",
      provider: "gcp",
      region: "us-central1",
      attributes: {},
    });
    const estimate = calculateGcpFunctionCost(resource, "gcp", "us-central1");

    // Default: 1M invocations, 200ms, 256MB
    // Invocation cost: 1 * $0.40 = $0.40
    // GB-seconds: 1_000_000 * 0.2 * (256/1024) = 50,000
    // Compute: 50,000 * $0.0000025 = $0.125
    expect(estimate.monthly_cost).toBeCloseTo(0.4 + 0.125, 2);
  });

  it("includes runtime note when runtime is set", () => {
    const resource = makeResource({
      type: "google_cloudfunctions_function",
      provider: "gcp",
      attributes: { runtime: "nodejs20" },
    });
    const estimate = calculateGcpFunctionCost(resource, "gcp", "us-central1");

    expect(estimate.notes.some((n) => n.includes("nodejs20"))).toBe(true);
  });
});
