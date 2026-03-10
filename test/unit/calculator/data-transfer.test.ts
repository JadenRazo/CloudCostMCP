import { describe, it, expect } from "vitest";
import {
  calculateAwsDataTransferCost,
  calculateAzureDataTransferCost,
  calculateGcpDataTransferCost,
  calculateNatDataProcessingCost,
} from "../../../src/calculator/data-transfer.js";
import type { ParsedResource } from "../../../src/types/resources.js";

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_data_transfer",
    name: "test-dt",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AWS Data Transfer
// ---------------------------------------------------------------------------

describe("calculateAwsDataTransferCost", () => {
  it("uses default assumptions when no attributes set", () => {
    const resource = makeResource({});
    const estimate = calculateAwsDataTransferCost(resource, "aws", "us-east-1");

    // Default: 100GB egress + 50GB cross-region
    // 100GB egress: first 1GB free, 99GB * $0.09 = $8.91
    // 50GB cross-region: 50 * $0.02 = $1.00
    const expectedEgress = 99 * 0.09;
    const expectedCrossRegion = 50 * 0.02;
    expect(estimate.monthly_cost).toBeCloseTo(expectedEgress + expectedCrossRegion, 1);
    expect(estimate.notes.some((n) => n.includes("Default egress assumption"))).toBe(true);
  });

  it("first 1GB of AWS egress is free", () => {
    const resource = makeResource({
      attributes: { monthly_egress_gb: 1, monthly_cross_region_gb: 0 },
    });
    const estimate = calculateAwsDataTransferCost(resource, "aws", "us-east-1");

    // 1GB is all free
    expect(estimate.monthly_cost).toBe(0);
  });

  it("charges 9999 GB tier at $0.09/GB", () => {
    const resource = makeResource({
      attributes: { monthly_egress_gb: 100, monthly_cross_region_gb: 0 },
    });
    const estimate = calculateAwsDataTransferCost(resource, "aws", "us-east-1");

    // 100GB - 1GB free = 99GB * $0.09
    expect(estimate.monthly_cost).toBeCloseTo(99 * 0.09, 2);
  });

  it("includes cross-AZ cost when specified", () => {
    const resource = makeResource({
      attributes: {
        monthly_egress_gb: 0,
        monthly_cross_region_gb: 0,
        monthly_cross_az_gb: 50,
      },
    });
    const estimate = calculateAwsDataTransferCost(resource, "aws", "us-east-1");

    // Cross-AZ: 50 * $0.01 = $0.50
    expect(estimate.monthly_cost).toBeCloseTo(0.50, 2);
  });
});

// ---------------------------------------------------------------------------
// Azure Data Transfer
// ---------------------------------------------------------------------------

describe("calculateAzureDataTransferCost", () => {
  it("uses default assumptions", () => {
    const resource = makeResource({
      type: "azurerm_data_transfer",
      provider: "azure",
      region: "eastus",
    });
    const estimate = calculateAzureDataTransferCost(resource, "azure", "eastus");

    // 100GB egress: first 5GB free, 95GB * $0.087 = $8.265
    // 50GB cross-region: 50 * $0.02 = $1.00
    const expectedEgress = 95 * 0.087;
    const expectedCrossRegion = 50 * 0.02;
    expect(estimate.monthly_cost).toBeCloseTo(expectedEgress + expectedCrossRegion, 1);
  });

  it("first 5GB of Azure egress is free", () => {
    const resource = makeResource({
      type: "azurerm_data_transfer",
      provider: "azure",
      region: "eastus",
      attributes: { monthly_egress_gb: 5, monthly_cross_region_gb: 0 },
    });
    const estimate = calculateAzureDataTransferCost(resource, "azure", "eastus");

    expect(estimate.monthly_cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GCP Data Transfer
// ---------------------------------------------------------------------------

describe("calculateGcpDataTransferCost", () => {
  it("uses premium tier by default", () => {
    const resource = makeResource({
      type: "google_data_transfer",
      provider: "gcp",
      region: "us-central1",
      attributes: { monthly_egress_gb: 100, monthly_cross_region_gb: 0 },
    });
    const estimate = calculateGcpDataTransferCost(resource, "gcp", "us-central1");

    // 100GB * $0.12 = $12
    expect(estimate.monthly_cost).toBeCloseTo(12, 2);
  });

  it("applies standard tier discount", () => {
    const premium = makeResource({
      type: "google_data_transfer",
      provider: "gcp",
      attributes: { monthly_egress_gb: 100, monthly_cross_region_gb: 0, network_tier: "PREMIUM" },
    });
    const standard = makeResource({
      type: "google_data_transfer",
      provider: "gcp",
      attributes: { monthly_egress_gb: 100, monthly_cross_region_gb: 0, network_tier: "STANDARD" },
    });

    const premiumEst = calculateGcpDataTransferCost(premium, "gcp", "us-central1");
    const standardEst = calculateGcpDataTransferCost(standard, "gcp", "us-central1");

    expect(standardEst.monthly_cost).toBeLessThan(premiumEst.monthly_cost);
    expect(standardEst.monthly_cost).toBeCloseTo(100 * 0.085, 2);
  });

  it("adds cross-region charges", () => {
    const resource = makeResource({
      type: "google_data_transfer",
      provider: "gcp",
      attributes: { monthly_egress_gb: 0, monthly_cross_region_gb: 100 },
    });
    const estimate = calculateGcpDataTransferCost(resource, "gcp", "us-central1");

    // Cross-region: 100 * $0.01 = $1
    expect(estimate.monthly_cost).toBeCloseTo(1.0, 2);
  });
});

// ---------------------------------------------------------------------------
// NAT data processing supplement
// ---------------------------------------------------------------------------

describe("calculateNatDataProcessingCost", () => {
  it("returns $0.045/GB for AWS", () => {
    const cost = calculateNatDataProcessingCost(100, "aws", "us-east-1");
    expect(cost).toBeCloseTo(4.50, 2);
  });

  it("returns $0.045/GB for Azure", () => {
    const cost = calculateNatDataProcessingCost(100, "azure", "eastus");
    expect(cost).toBeCloseTo(4.50, 2);
  });

  it("returns $0.045/GB for GCP", () => {
    const cost = calculateNatDataProcessingCost(100, "gcp", "us-central1");
    expect(cost).toBeCloseTo(4.50, 2);
  });
});
