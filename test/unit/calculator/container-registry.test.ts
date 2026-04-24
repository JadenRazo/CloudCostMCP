import { describe, it, expect } from "vitest";
import { calculateContainerRegistryCost } from "../../../src/calculator/container-registry.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateContainerRegistryCost", () => {
  // -------------------------------------------------------------------------
  // AWS ECR
  // -------------------------------------------------------------------------

  it("calculates AWS ECR cost at $0.10/GB with default 10 GB when storage_gb is unspecified", () => {
    const resource = makeResource({
      type: "aws_ecr_repository",
      provider: "aws",
      attributes: {},
    });

    const estimate = calculateContainerRegistryCost(resource, "aws", "us-east-1");

    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 10, 5);
    expect(estimate.yearly_cost).toBeCloseTo(0.1 * 10 * 12, 5);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
    expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(true);
  });

  it("calculates AWS ECR cost with explicit storage_gb", () => {
    const resource = makeResource({
      type: "aws_ecr_repository",
      provider: "aws",
      attributes: { storage_gb: 50 },
    });

    const estimate = calculateContainerRegistryCost(resource, "aws", "us-east-1");

    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 50, 5);
    expect(estimate.confidence).toBe("high");
    expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(false);
  });

  it("includes a GB-Mo breakdown line item", () => {
    const resource = makeResource({
      type: "aws_ecr_repository",
      provider: "aws",
      attributes: { storage_gb: 20 },
    });

    const estimate = calculateContainerRegistryCost(resource, "aws", "us-east-1");

    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.breakdown[0].unit).toBe("GB-Mo");
    expect(estimate.breakdown[0].quantity).toBe(20);
  });

  // -------------------------------------------------------------------------
  // Azure Container Registry
  // -------------------------------------------------------------------------

  it("calculates Azure ACR Basic tier cost at $0.167/GB", () => {
    const resource = makeResource({
      type: "azurerm_container_registry",
      provider: "azure",
      attributes: { sku: "Basic", storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(0.167 * 10, 5);
    expect(estimate.provider).toBe("azure");
  });

  it("calculates Azure ACR Standard tier cost at $0.667/GB", () => {
    const resource = makeResource({
      type: "azurerm_container_registry",
      provider: "azure",
      attributes: { sku: "Standard", storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(0.667 * 10, 5);
  });

  it("calculates Azure ACR Premium tier cost at $1.667/GB", () => {
    const resource = makeResource({
      type: "azurerm_container_registry",
      provider: "azure",
      attributes: { sku: "Premium", storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(1.667 * 10, 5);
  });

  it("defaults Azure ACR to Basic tier when no sku is specified", () => {
    const resource = makeResource({
      type: "azurerm_container_registry",
      provider: "azure",
      attributes: { storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(0.167 * 10, 5);
  });

  it("adds a note for unknown Azure ACR SKU and falls back to Basic pricing", () => {
    const resource = makeResource({
      type: "azurerm_container_registry",
      provider: "azure",
      attributes: { sku: "Enterprise", storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBeCloseTo(0.167 * 10, 5);
    expect(estimate.notes.some((n) => n.includes("Enterprise"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GCP Artifact Registry
  // -------------------------------------------------------------------------

  it("calculates GCP Artifact Registry cost at $0.10/GB", () => {
    const resource = makeResource({
      type: "google_artifact_registry_repository",
      provider: "gcp",
      attributes: { storage_gb: 25 },
    });

    const estimate = calculateContainerRegistryCost(resource, "gcp", "us-central1");

    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 25, 5);
    expect(estimate.provider).toBe("gcp");
  });

  it("GCP defaults to 10 GB with medium confidence when storage_gb is absent", () => {
    const resource = makeResource({
      type: "google_artifact_registry_repository",
      provider: "gcp",
      attributes: {},
    });

    const estimate = calculateContainerRegistryCost(resource, "gcp", "us-central1");

    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 10, 5);
    expect(estimate.confidence).toBe("medium");
  });

  // -------------------------------------------------------------------------
  // Cross-provider targeting
  // -------------------------------------------------------------------------

  it("targets GCP pricing when an AWS ECR resource is compared to GCP", () => {
    const resource = makeResource({
      type: "aws_ecr_repository",
      provider: "aws",
      attributes: { storage_gb: 10 },
    });

    const estimate = calculateContainerRegistryCost(resource, "gcp", "us-central1");

    // GCP price is $0.10/GB, same as AWS, so result should be the same
    expect(estimate.monthly_cost).toBeCloseTo(0.1 * 10, 5);
    expect(estimate.provider).toBe("gcp");
  });

  it("includes resource metadata in the estimate", () => {
    const resource = makeResource({
      id: "aws_ecr_repository.my_repo",
      type: "aws_ecr_repository",
      name: "my-repo",
      provider: "aws",
      attributes: { storage_gb: 5 },
    });

    const estimate = calculateContainerRegistryCost(resource, "aws", "us-east-1");

    expect(estimate.resource_id).toBe("aws_ecr_repository.my_repo");
    expect(estimate.resource_type).toBe("aws_ecr_repository");
    expect(estimate.resource_name).toBe("my-repo");
    expect(estimate.region).toBe("us-east-1");
  });
});
