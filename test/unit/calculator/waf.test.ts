import { describe, it, expect } from "vitest";
import { calculateWafCost } from "../../../src/calculator/waf.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateWafCost", () => {
  // -------------------------------------------------------------------------
  // AWS WAFv2
  // -------------------------------------------------------------------------

  describe("AWS WAFv2", () => {
    it("should calculate cost with ACL + rules + request inspection", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: {
          rule_count: 5,
          monthly_requests: 10_000_000,
        },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      // ACL: $5.00
      // Rules: 5 * $1.00 = $5.00
      // Requests: 10M / 1M * $0.60 = $6.00
      // Total: $16.00
      expect(estimate.monthly_cost).toBeCloseTo(16.0, 2);
      expect(estimate.provider).toBe("aws");
      expect(estimate.confidence).toBe("high");
      expect(estimate.breakdown.length).toBe(3);
    });

    it("should use defaults when no attributes are provided", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: {},
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      // ACL: $5.00
      // Rules: 10 * $1.00 = $10.00 (default 10 rules)
      // Requests: 10M / 1M * $0.60 = $6.00 (default 10M)
      // Total: $21.00
      expect(estimate.monthly_cost).toBeCloseTo(21.0, 2);
      expect(estimate.confidence).toBe("medium");
      expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(true);
    });

    it("should include scope note", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { scope: "CLOUDFRONT", rule_count: 1, monthly_requests: 1_000_000 },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      expect(estimate.notes.some((n) => n.includes("CLOUDFRONT"))).toBe(true);
    });

    it("should default scope to REGIONAL when not specified", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 1, monthly_requests: 1_000_000 },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      expect(estimate.notes.some((n) => n.includes("REGIONAL"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Azure WAF
  // -------------------------------------------------------------------------

  describe("Azure WAF", () => {
    it("should calculate cost with gateway fee + rules + request processing", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_web_application_firewall_policy",
        attributes: {
          rule_count: 5,
          monthly_requests: 10_000_000,
        },
      });

      const estimate = calculateWafCost(resource, "azure", "eastus");

      // Gateway: $323.39
      // Rules: 5 * $1.00 = $5.00
      // Requests: 10M / 1M * $0.65 = $6.50
      // Total: $334.89
      expect(estimate.monthly_cost).toBeCloseTo(334.89, 1);
      expect(estimate.provider).toBe("azure");
      expect(estimate.breakdown.length).toBe(3);
    });

    it("should use defaults when no attributes are provided", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_web_application_firewall_policy",
        attributes: {},
      });

      const estimate = calculateWafCost(resource, "azure", "eastus");

      // Gateway: $323.39
      // Rules: 10 * $1.00 = $10.00
      // Requests: 10M / 1M * $0.65 = $6.50
      // Total: $339.89
      expect(estimate.monthly_cost).toBeCloseTo(339.89, 1);
    });
  });

  // -------------------------------------------------------------------------
  // GCP Cloud Armor
  // -------------------------------------------------------------------------

  describe("GCP Cloud Armor", () => {
    it("should calculate cost with policy + rules + request evaluation", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_compute_security_policy",
        attributes: {
          rule_count: 5,
          monthly_requests: 10_000_000,
        },
      });

      const estimate = calculateWafCost(resource, "gcp", "us-central1");

      // Policy: $5.00
      // Rules: 5 * $1.00 = $5.00
      // Requests: 10M / 1M * $0.75 = $7.50
      // Total: $17.50
      expect(estimate.monthly_cost).toBeCloseTo(17.5, 2);
      expect(estimate.provider).toBe("gcp");
      expect(estimate.notes.some((n) => n.includes("Cloud Armor"))).toBe(true);
    });

    it("should use defaults when no attributes are provided", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_compute_security_policy",
        attributes: {},
      });

      const estimate = calculateWafCost(resource, "gcp", "us-central1");

      // Policy: $5.00
      // Rules: 10 * $1.00 = $10.00
      // Requests: 10M / 1M * $0.75 = $7.50
      // Total: $22.50
      expect(estimate.monthly_cost).toBeCloseTo(22.5, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle zero rules", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 0, monthly_requests: 1_000_000 },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      // ACL: $5.00 + Rules: $0 + Requests: 1M * $0.60 = $0.60
      expect(estimate.monthly_cost).toBeCloseTo(5.6, 2);
    });

    it("should handle zero requests", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 5, monthly_requests: 0 },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      // ACL: $5.00 + Rules: 5 * $1.00 = $5.00 + Requests: $0
      expect(estimate.monthly_cost).toBeCloseTo(10.0, 2);
    });

    it("should set yearly_cost to 12x monthly_cost", () => {
      const resource = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 3, monthly_requests: 5_000_000 },
      });

      const estimate = calculateWafCost(resource, "aws", "us-east-1");

      expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 2);
    });

    it("should report high confidence only when both rule_count and monthly_requests are explicit", () => {
      const onlyRules = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 5 },
      });
      const onlyRequests = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { monthly_requests: 5_000_000 },
      });
      const both = makeResource({
        type: "aws_wafv2_web_acl",
        attributes: { rule_count: 5, monthly_requests: 5_000_000 },
      });

      expect(calculateWafCost(onlyRules, "aws", "us-east-1").confidence).toBe("medium");
      expect(calculateWafCost(onlyRequests, "aws", "us-east-1").confidence).toBe("medium");
      expect(calculateWafCost(both, "aws", "us-east-1").confidence).toBe("high");
    });
  });
});
