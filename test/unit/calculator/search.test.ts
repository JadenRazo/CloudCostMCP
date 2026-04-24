import { describe, it, expect } from "vitest";
import { calculateSearchCost } from "../../../src/calculator/search.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateSearchCost", () => {
  // -------------------------------------------------------------------------
  // AWS OpenSearch
  // -------------------------------------------------------------------------

  describe("AWS OpenSearch", () => {
    it("should calculate cost for a known instance type with storage", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: {
          instance_type: "m5.large.search",
          instance_count: 2,
          volume_size: 50,
        },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Instance: 2 * $0.142/hr * 730h = $207.32
      // Storage: 50 GB * 2 instances * $0.122/GB = $12.20
      // Total: $219.52
      expect(estimate.monthly_cost).toBeCloseTo(219.52, 0);
      expect(estimate.provider).toBe("aws");
      expect(estimate.confidence).toBe("medium");
      expect(estimate.breakdown.length).toBe(2);
    });

    it("should use default t3.medium.search rate for unknown instance type", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: { instance_type: "r99.fantasy.search" },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Fallback: $0.073/hr * 730h = $53.29 + storage: 10 GB * $0.122 = $1.22
      expect(estimate.monthly_cost).toBeCloseTo(54.51, 0);
      expect(estimate.notes.some((n) => n.includes("fallback"))).toBe(true);
    });

    it("should use gp2 storage rate when volume_type is gp2", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: {
          instance_type: "t3.small.search",
          instance_count: 1,
          volume_size: 20,
          volume_type: "gp2",
        },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Instance: $0.036/hr * 730h = $26.28
      // Storage: 20 GB * 1 * $0.135/GB = $2.70
      // Total: $28.98
      expect(estimate.monthly_cost).toBeCloseTo(28.98, 0);
    });

    it("should default to gp3 storage rate", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: {
          instance_type: "t3.small.search",
          instance_count: 1,
          volume_size: 20,
        },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Instance: $0.036/hr * 730h = $26.28
      // Storage: 20 GB * 1 * $0.122/GB = $2.44
      // Total: $28.72
      expect(estimate.monthly_cost).toBeCloseTo(28.72, 0);
    });

    it("should use defaults when no attributes are provided", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: {},
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Default: t3.medium.search, 1 instance, 10 GB gp3
      // Instance: $0.073/hr * 730h = $53.29
      // Storage: 10 GB * 1 * $0.122 = $1.22
      // Total: ~$54.51
      expect(estimate.monthly_cost).toBeCloseTo(54.51, 0);
      expect(estimate.monthly_cost).toBeGreaterThan(0);
    });

    it("should include engine version note when specified", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: { engine_version: "OpenSearch_2.7" },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      expect(estimate.notes.some((n) => n.includes("OpenSearch_2.7"))).toBe(true);
    });

    it("should accept storage_size_gb as an alternative attribute name", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: {
          instance_type: "t3.medium.search",
          storage_size_gb: 100,
        },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Instance: $0.073/hr * 730h = $53.29
      // Storage: 100 GB * 1 * $0.122 = $12.20
      // Total: ~$65.49
      expect(estimate.monthly_cost).toBeCloseTo(65.49, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Azure AI Search
  // -------------------------------------------------------------------------

  describe("Azure", () => {
    it("should return fixed Standard S1 cost as cross-provider estimate", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_search_service",
        attributes: {},
      });

      const estimate = calculateSearchCost(resource, "azure", "eastus");

      expect(estimate.monthly_cost).toBeCloseTo(250.46, 2);
      expect(estimate.provider).toBe("azure");
      expect(estimate.confidence).toBe("low");
      expect(estimate.notes.some((n) => n.includes("Azure AI Search"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GCP
  // -------------------------------------------------------------------------

  describe("GCP", () => {
    it("should return estimated equivalent cost", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_compute_instance",
        attributes: {},
      });

      const estimate = calculateSearchCost(resource, "gcp", "us-central1");

      expect(estimate.monthly_cost).toBeCloseTo(200.0, 2);
      expect(estimate.provider).toBe("gcp");
      expect(estimate.confidence).toBe("low");
      expect(estimate.notes.some((n) => n.includes("no direct managed OpenSearch"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should set yearly_cost to 12x monthly_cost", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: { instance_type: "m5.large.search", instance_count: 1, volume_size: 10 },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 2);
    });

    it("should handle zero volume size with no storage breakdown", () => {
      const resource = makeResource({
        type: "aws_opensearch_domain",
        attributes: { instance_type: "t3.medium.search", volume_size: 0 },
      });

      const estimate = calculateSearchCost(resource, "aws", "us-east-1");

      // Only instance cost, no storage line
      expect(estimate.breakdown.length).toBe(1);
      // $0.073 * 730 = $53.29
      expect(estimate.monthly_cost).toBeCloseTo(53.29, 0);
    });
  });
});
