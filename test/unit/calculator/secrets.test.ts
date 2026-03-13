import { describe, it, expect } from "vitest";
import { calculateSecretsCost } from "../../../src/calculator/secrets.js";
import type { ParsedResource } from "../../../src/types/resources.js";

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test.secret",
    type: "aws_secretsmanager_secret",
    name: "test-secret",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

describe("calculateSecretsCost", () => {
  // -------------------------------------------------------------------------
  // AWS Secrets Manager
  // -------------------------------------------------------------------------

  it("calculates AWS Secrets Manager cost with default 1 secret and 10k API calls", () => {
    const resource = makeResource({
      type: "aws_secretsmanager_secret",
      provider: "aws",
      attributes: {},
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    // $0.40 * 1 secret + $0.05 * (10000/10000) = $0.45
    expect(estimate.monthly_cost).toBeCloseTo(0.40 + 0.05, 5);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
    expect(estimate.notes.some((n) => n.includes("secret_count"))).toBe(true);
  });

  it("calculates AWS Secrets Manager cost with explicit secret_count", () => {
    const resource = makeResource({
      type: "aws_secretsmanager_secret",
      provider: "aws",
      attributes: { secret_count: 5 },
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    // $0.40 * 5 + $0.05 * 1 (default 10k calls) = $2.05
    expect(estimate.monthly_cost).toBeCloseTo(0.40 * 5 + 0.05, 5);
    expect(estimate.confidence).toBe("high");
  });

  it("includes both secret fee and API call line items for AWS", () => {
    const resource = makeResource({
      type: "aws_secretsmanager_secret",
      provider: "aws",
      attributes: { secret_count: 1 },
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    expect(estimate.breakdown).toHaveLength(2);
    expect(estimate.breakdown[0].description).toMatch(/secret storage/i);
    expect(estimate.breakdown[1].description).toMatch(/API calls/i);
  });

  it("calculates AWS Secrets Manager cost with custom api_calls_per_month", () => {
    const resource = makeResource({
      type: "aws_secretsmanager_secret",
      provider: "aws",
      attributes: { secret_count: 1, api_calls_per_month: 100_000 },
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    // $0.40 * 1 + $0.05 * (100000/10000) = $0.40 + $0.50 = $0.90
    expect(estimate.monthly_cost).toBeCloseTo(0.40 + 0.05 * 10, 5);
  });

  // -------------------------------------------------------------------------
  // Azure Key Vault
  // -------------------------------------------------------------------------

  it("calculates Azure Key Vault cost with default 10k operations", () => {
    const resource = makeResource({
      type: "azurerm_key_vault",
      provider: "azure",
      attributes: {},
    });

    const estimate = calculateSecretsCost(resource, "azure", "eastus");

    // $0.03 * (10000/10000) = $0.03
    expect(estimate.monthly_cost).toBeCloseTo(0.03, 5);
    expect(estimate.provider).toBe("azure");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates Azure Key Vault cost with explicit operations_per_month", () => {
    const resource = makeResource({
      type: "azurerm_key_vault",
      provider: "azure",
      attributes: { secret_count: 10, operations_per_month: 50_000 },
    });

    const estimate = calculateSecretsCost(resource, "azure", "eastus");

    // $0.03 * (50000/10000) = $0.15
    expect(estimate.monthly_cost).toBeCloseTo(0.03 * 5, 5);
    expect(estimate.confidence).toBe("high");
  });

  it("Azure Key Vault estimate includes a note about key operations being free", () => {
    const resource = makeResource({
      type: "azurerm_key_vault",
      provider: "azure",
      attributes: {},
    });

    const estimate = calculateSecretsCost(resource, "azure", "eastus");

    expect(estimate.notes.some((n) => n.includes("key operations"))).toBe(true);
  });

  it("Azure Key Vault has a single operations breakdown line item", () => {
    const resource = makeResource({
      type: "azurerm_key_vault",
      provider: "azure",
      attributes: {},
    });

    const estimate = calculateSecretsCost(resource, "azure", "eastus");

    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.breakdown[0].unit).toBe("10K ops");
  });

  // -------------------------------------------------------------------------
  // GCP Secret Manager
  // -------------------------------------------------------------------------

  it("calculates GCP Secret Manager cost with default 1 version and 10k access ops", () => {
    const resource = makeResource({
      type: "google_secret_manager_secret",
      provider: "gcp",
      attributes: {},
    });

    const estimate = calculateSecretsCost(resource, "gcp", "us-central1");

    // $0.06 * 1 version + $0.03 * (10000/10000) = $0.09
    expect(estimate.monthly_cost).toBeCloseTo(0.06 + 0.03, 5);
    expect(estimate.provider).toBe("gcp");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates GCP Secret Manager cost with explicit versions attribute", () => {
    const resource = makeResource({
      type: "google_secret_manager_secret",
      provider: "gcp",
      attributes: { versions: 3 },
    });

    const estimate = calculateSecretsCost(resource, "gcp", "us-central1");

    // $0.06 * 3 + $0.03 * 1 = $0.21
    expect(estimate.monthly_cost).toBeCloseTo(0.06 * 3 + 0.03, 5);
    expect(estimate.confidence).toBe("high");
  });

  it("includes both version fee and access op line items for GCP", () => {
    const resource = makeResource({
      type: "google_secret_manager_secret",
      provider: "gcp",
      attributes: { versions: 1 },
    });

    const estimate = calculateSecretsCost(resource, "gcp", "us-central1");

    expect(estimate.breakdown).toHaveLength(2);
    expect(estimate.breakdown[0].description).toMatch(/active versions/i);
    expect(estimate.breakdown[1].description).toMatch(/access operations/i);
  });

  it("calculates GCP Secret Manager with custom access_operations_per_month", () => {
    const resource = makeResource({
      type: "google_secret_manager_secret",
      provider: "gcp",
      attributes: { versions: 1, access_operations_per_month: 50_000 },
    });

    const estimate = calculateSecretsCost(resource, "gcp", "us-central1");

    // $0.06 * 1 + $0.03 * (50000/10000) = $0.06 + $0.15 = $0.21
    expect(estimate.monthly_cost).toBeCloseTo(0.06 + 0.03 * 5, 5);
  });

  // -------------------------------------------------------------------------
  // Shared behaviour
  // -------------------------------------------------------------------------

  it("yearly_cost is 12x monthly_cost", () => {
    const resource = makeResource({
      type: "aws_secretsmanager_secret",
      provider: "aws",
      attributes: { secret_count: 2 },
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 5);
  });

  it("includes resource metadata in the estimate", () => {
    const resource = makeResource({
      id: "aws_secretsmanager_secret.db_password",
      type: "aws_secretsmanager_secret",
      name: "db-password",
      provider: "aws",
      attributes: { secret_count: 1 },
    });

    const estimate = calculateSecretsCost(resource, "aws", "us-east-1");

    expect(estimate.resource_id).toBe("aws_secretsmanager_secret.db_password");
    expect(estimate.resource_type).toBe("aws_secretsmanager_secret");
    expect(estimate.resource_name).toBe("db-password");
  });
});
