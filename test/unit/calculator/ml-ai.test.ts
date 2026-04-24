import { describe, it, expect } from "vitest";
import { calculateMlAiCost } from "../../../src/calculator/ml-ai.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateMlAiCost", () => {
  // -------------------------------------------------------------------------
  // AWS SageMaker
  // -------------------------------------------------------------------------

  describe("AWS SageMaker", () => {
    it("should calculate cost for a known ml.m5.large instance", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: { instance_type: "ml.m5.large", instance_count: 1 },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // $0.115/hr * 730h = $83.95
      expect(estimate.monthly_cost).toBeCloseTo(83.95, 0);
      expect(estimate.provider).toBe("aws");
      expect(estimate.confidence).toBe("low");
      expect(estimate.breakdown.length).toBe(1);
    });

    it("should scale cost by instance_count", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: { instance_type: "ml.m5.large", instance_count: 3 },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // $0.115/hr * 730h * 3 = $251.85
      expect(estimate.monthly_cost).toBeCloseTo(251.85, 0);
    });

    it("should calculate GPU instance cost (ml.p3.2xlarge)", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: { instance_type: "ml.p3.2xlarge" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // $3.825/hr * 730h = $2792.25
      expect(estimate.monthly_cost).toBeCloseTo(2792.25, 0);
    });

    it("should calculate Inferentia instance cost (ml.inf1.xlarge)", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: { instance_type: "ml.inf1.xlarge" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // $0.297/hr * 730h = $216.81
      expect(estimate.monthly_cost).toBeCloseTo(216.81, 0);
    });

    it("should report $0 cost for unknown instance type with explanatory note", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: { instance_type: "ml.unknown.type" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.notes.some((n) => n.includes("No pricing data"))).toBe(true);
    });

    it("should default to ml.m5.large when instance_type is not specified", () => {
      const resource = makeResource({
        type: "aws_sagemaker_endpoint_configuration",
        attributes: {},
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // Default ml.m5.large: $0.115/hr * 730h = $83.95
      expect(estimate.monthly_cost).toBeCloseTo(83.95, 0);
    });
  });

  // -------------------------------------------------------------------------
  // GCP Vertex AI
  // -------------------------------------------------------------------------

  describe("GCP Vertex AI", () => {
    it("should calculate cost for a known n1-standard-4 machine", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_vertex_ai_endpoint",
        attributes: { machine_type: "n1-standard-4", instance_count: 1 },
      });

      const estimate = calculateMlAiCost(resource, "gcp", "us-central1");

      // $0.19/hr * 730h = $138.70
      expect(estimate.monthly_cost).toBeCloseTo(138.7, 0);
      expect(estimate.provider).toBe("gcp");
    });

    it("should scale cost by instance_count", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_vertex_ai_endpoint",
        attributes: { machine_type: "n1-standard-4", instance_count: 2 },
      });

      const estimate = calculateMlAiCost(resource, "gcp", "us-central1");

      // $0.19/hr * 730h * 2 = $277.40
      expect(estimate.monthly_cost).toBeCloseTo(277.4, 0);
    });

    it("should calculate GPU-enabled machine cost", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_vertex_ai_endpoint",
        attributes: { machine_type: "n1-standard-8-nvidia-tesla-v100" },
      });

      const estimate = calculateMlAiCost(resource, "gcp", "us-central1");

      // $2.88/hr * 730h = $2102.40
      expect(estimate.monthly_cost).toBeCloseTo(2102.4, 0);
    });

    it("should report $0 for unknown machine type", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_vertex_ai_endpoint",
        attributes: { machine_type: "unknown-machine" },
      });

      const estimate = calculateMlAiCost(resource, "gcp", "us-central1");

      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.notes.some((n) => n.includes("No pricing data"))).toBe(true);
    });

    it("should default to n1-standard-4 when machine_type is not specified", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_vertex_ai_endpoint",
        attributes: {},
      });

      const estimate = calculateMlAiCost(resource, "gcp", "us-central1");

      // $0.19/hr * 730h = $138.70
      expect(estimate.monthly_cost).toBeCloseTo(138.7, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Azure (not yet supported)
  // -------------------------------------------------------------------------

  describe("Azure", () => {
    it("should return $0 cost with a note about unsupported Azure ML", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_machine_learning_compute_instance",
        attributes: {},
      });

      const estimate = calculateMlAiCost(resource, "azure", "eastus");

      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.provider).toBe("azure");
      expect(
        estimate.notes.some((n) => n.includes("Azure ML endpoint pricing not yet supported")),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should always have confidence low for fallback ML pricing", () => {
      const resource = makeResource({
        attributes: { instance_type: "ml.m5.large" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      expect(estimate.confidence).toBe("low");
    });

    it("should set yearly_cost to 12x monthly_cost", () => {
      const resource = makeResource({
        attributes: { instance_type: "ml.g5.xlarge" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      // $1.006/hr * 730h = $734.38
      expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 2);
    });

    it("should include auto-scaling variability note for AWS", () => {
      const resource = makeResource({
        attributes: { instance_type: "ml.m5.large" },
      });

      const estimate = calculateMlAiCost(resource, "aws", "us-east-1");

      expect(estimate.notes.some((n) => n.includes("auto-scaling"))).toBe(true);
    });
  });
});
