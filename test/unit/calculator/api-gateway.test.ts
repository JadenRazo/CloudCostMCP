import { describe, it, expect } from "vitest";
import { calculateApiGatewayCost } from "../../../src/calculator/api-gateway.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateApiGatewayCost", () => {
  // -------------------------------------------------------------------------
  // AWS
  // -------------------------------------------------------------------------

  describe("AWS", () => {
    it("should calculate REST API cost at $3.50/million requests by default", () => {
      const resource = makeResource({
        type: "aws_api_gateway_rest_api",
        attributes: { monthly_requests: 5_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      // 5M requests * $3.50/M = $17.50
      expect(estimate.monthly_cost).toBeCloseTo(17.5, 2);
      expect(estimate.yearly_cost).toBeCloseTo(17.5 * 12, 0);
      expect(estimate.provider).toBe("aws");
      expect(estimate.currency).toBe("USD");
      expect(estimate.confidence).toBe("high");
      expect(estimate.breakdown.length).toBe(1);
    });

    it("should calculate HTTP API cost at $1.00/million requests", () => {
      const resource = makeResource({
        type: "aws_apigatewayv2_api",
        attributes: { api_type: "HTTP", monthly_requests: 10_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      // 10M * $1.00/M = $10.00
      expect(estimate.monthly_cost).toBeCloseTo(10.0, 2);
      expect(estimate.breakdown[0].unit_price).toBe(1.0);
    });

    it("should calculate WebSocket API cost with messages and connection-minutes", () => {
      const resource = makeResource({
        type: "aws_apigatewayv2_api",
        attributes: { api_type: "WEBSOCKET", monthly_requests: 2_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      // 2M messages * $1.00/M + 2M conn-min * $1.00/M = $4.00
      expect(estimate.monthly_cost).toBeCloseTo(4.0, 2);
      expect(estimate.breakdown.length).toBe(2);
      expect(estimate.notes.some((n) => n.includes("WebSocket"))).toBe(true);
    });

    it("should default to REST API when api_type is not specified", () => {
      const resource = makeResource({
        type: "aws_api_gateway_rest_api",
        attributes: { monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      // REST default: 1M * $3.50/M = $3.50
      expect(estimate.monthly_cost).toBeCloseTo(3.5, 2);
    });

    it("should assume 1M requests/month when monthly_requests is not specified", () => {
      const resource = makeResource({
        type: "aws_api_gateway_rest_api",
        attributes: {},
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      // Default 1M * $3.50/M = $3.50
      expect(estimate.monthly_cost).toBeCloseTo(3.5, 2);
      expect(estimate.confidence).toBe("medium");
      expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Azure
  // -------------------------------------------------------------------------

  describe("Azure", () => {
    it("should calculate consumption tier cost based on request volume", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { sku: "Consumption", monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      // 1M / 10K = 100 units * $0.035 = $3.50
      expect(estimate.monthly_cost).toBeCloseTo(3.5, 2);
      expect(estimate.provider).toBe("azure");
    });

    it("should return fixed cost for Developer tier", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { sku: "Developer", monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      expect(estimate.monthly_cost).toBeCloseTo(48.36, 2);
    });

    it("should return fixed cost for Standard tier", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { sku: "Standard" },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      expect(estimate.monthly_cost).toBeCloseTo(683.28, 2);
    });

    it("should return fixed cost for Premium tier", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { sku: "Premium" },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      expect(estimate.monthly_cost).toBeCloseTo(2803.46, 2);
    });

    it("should default to consumption tier when sku is not specified", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      // Consumption: 1M / 10K = 100 * $0.035 = $3.50
      expect(estimate.monthly_cost).toBeCloseTo(3.5, 2);
    });
  });

  // -------------------------------------------------------------------------
  // GCP
  // -------------------------------------------------------------------------

  describe("GCP", () => {
    it("should apply free tier for requests under 2M", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_api_gateway_api",
        attributes: { monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "gcp", "us-central1");

      // 1M is within 2M free tier, cost = $0
      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.notes.some((n) => n.includes("free tier"))).toBe(true);
    });

    it("should charge $3.00/million for requests above 2M free tier", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_api_gateway_api",
        attributes: { monthly_requests: 5_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "gcp", "us-central1");

      // (5M - 2M free) = 3M billable * $3.00/M = $9.00
      expect(estimate.monthly_cost).toBeCloseTo(9.0, 2);
      expect(estimate.provider).toBe("gcp");
    });

    it("should cost zero when requests exactly equal free tier", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_api_gateway_api",
        attributes: { monthly_requests: 2_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "gcp", "us-central1");

      expect(estimate.monthly_cost).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle zero requests", () => {
      const resource = makeResource({
        attributes: { monthly_requests: 0 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      expect(estimate.monthly_cost).toBe(0);
    });

    it("should handle unknown Azure sku by falling back to consumption", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_api_management",
        attributes: { sku: "unknown-tier", monthly_requests: 1_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "azure", "eastus");

      // Falls back to consumption: 1M / 10K * $0.035 = $3.50
      expect(estimate.monthly_cost).toBeCloseTo(3.5, 2);
    });

    it("should set yearly_cost to 12x monthly_cost", () => {
      const resource = makeResource({
        attributes: { monthly_requests: 10_000_000 },
      });

      const estimate = calculateApiGatewayCost(resource, "aws", "us-east-1");

      expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 2);
    });
  });
});
