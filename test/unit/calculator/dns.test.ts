import { describe, it, expect } from "vitest";
import { calculateDnsCost } from "../../../src/calculator/dns.js";
import type { ParsedResource } from "../../../src/types/resources.js";

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test.zone",
    type: "aws_route53_zone",
    name: "test-zone",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

describe("calculateDnsCost", () => {
  // -------------------------------------------------------------------------
  // AWS Route 53
  // -------------------------------------------------------------------------

  it("calculates AWS Route 53 cost with default 1M queries/month", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: {},
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    // $0.50 zone + $0.40 * (1_000_000/1_000_000) = $0.90
    expect(estimate.monthly_cost).toBeCloseTo(0.50 + 0.40, 5);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
    expect(estimate.notes.some((n) => n.includes("queries_per_month"))).toBe(true);
  });

  it("calculates AWS Route 53 cost with explicit queries_per_month", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 5_000_000 },
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    // $0.50 + $0.40 * 5 = $2.50
    expect(estimate.monthly_cost).toBeCloseTo(0.50 + 0.40 * 5, 5);
    expect(estimate.confidence).toBe("high");
    expect(estimate.notes.some((n) => n.includes("queries_per_month"))).toBe(false);
  });

  it("includes zone fee and query charge breakdown lines for AWS", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    expect(estimate.breakdown).toHaveLength(2);
    expect(estimate.breakdown[0].description).toMatch(/hosted zone/i);
    expect(estimate.breakdown[1].description).toMatch(/queries/i);
    expect(estimate.breakdown[0].unit).toBe("zone/Mo");
    expect(estimate.breakdown[1].unit).toBe("million queries");
  });

  it("zone fee line item has quantity 1 and correct unit_price", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    expect(estimate.breakdown[0].quantity).toBe(1);
    expect(estimate.breakdown[0].unit_price).toBeCloseTo(0.50, 5);
  });

  // -------------------------------------------------------------------------
  // Azure DNS
  // -------------------------------------------------------------------------

  it("calculates Azure DNS cost with default 1M queries/month", () => {
    const resource = makeResource({
      type: "azurerm_dns_zone",
      provider: "azure",
      attributes: {},
    });

    const estimate = calculateDnsCost(resource, "azure", "eastus");

    // $0.50 zone + $0.40 * 1 = $0.90
    expect(estimate.monthly_cost).toBeCloseTo(0.50 + 0.40, 5);
    expect(estimate.provider).toBe("azure");
    expect(estimate.pricing_source).toBe("bundled");
  });

  it("calculates Azure DNS cost with explicit queries_per_month", () => {
    const resource = makeResource({
      type: "azurerm_dns_zone",
      provider: "azure",
      attributes: { queries_per_month: 2_000_000 },
    });

    const estimate = calculateDnsCost(resource, "azure", "eastus");

    // $0.50 + $0.40 * 2 = $1.30
    expect(estimate.monthly_cost).toBeCloseTo(0.50 + 0.40 * 2, 5);
    expect(estimate.confidence).toBe("high");
  });

  it("Azure DNS has same per-zone and per-query pricing as AWS", () => {
    const awsResource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });
    const azureResource = makeResource({
      type: "azurerm_dns_zone",
      provider: "azure",
      attributes: { queries_per_month: 1_000_000 },
    });

    const awsEstimate = calculateDnsCost(awsResource, "aws", "us-east-1");
    const azureEstimate = calculateDnsCost(azureResource, "azure", "eastus");

    expect(awsEstimate.monthly_cost).toBeCloseTo(azureEstimate.monthly_cost, 5);
  });

  // -------------------------------------------------------------------------
  // GCP Cloud DNS
  // -------------------------------------------------------------------------

  it("calculates GCP Cloud DNS cost with default 1M queries/month", () => {
    const resource = makeResource({
      type: "google_dns_managed_zone",
      provider: "gcp",
      attributes: {},
    });

    const estimate = calculateDnsCost(resource, "gcp", "us-central1");

    // $0.20 zone + $0.40 * 1 = $0.60
    expect(estimate.monthly_cost).toBeCloseTo(0.20 + 0.40, 5);
    expect(estimate.provider).toBe("gcp");
    expect(estimate.pricing_source).toBe("bundled");
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates GCP Cloud DNS cost with explicit queries_per_month", () => {
    const resource = makeResource({
      type: "google_dns_managed_zone",
      provider: "gcp",
      attributes: { queries_per_month: 10_000_000 },
    });

    const estimate = calculateDnsCost(resource, "gcp", "us-central1");

    // $0.20 + $0.40 * 10 = $4.20
    expect(estimate.monthly_cost).toBeCloseTo(0.20 + 0.40 * 10, 5);
    expect(estimate.confidence).toBe("high");
  });

  it("GCP Cloud DNS has a lower zone fee than AWS Route 53", () => {
    const awsResource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });
    const gcpResource = makeResource({
      type: "google_dns_managed_zone",
      provider: "gcp",
      attributes: { queries_per_month: 1_000_000 },
    });

    const awsEstimate = calculateDnsCost(awsResource, "aws", "us-east-1");
    const gcpEstimate = calculateDnsCost(gcpResource, "gcp", "us-central1");

    // GCP zone fee ($0.20) is less than AWS zone fee ($0.50)
    expect(gcpEstimate.monthly_cost).toBeLessThan(awsEstimate.monthly_cost);
  });

  // -------------------------------------------------------------------------
  // Shared behaviour
  // -------------------------------------------------------------------------

  it("yearly_cost is 12x monthly_cost", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 5);
  });

  it("includes resource metadata in the estimate", () => {
    const resource = makeResource({
      id: "aws_route53_zone.primary",
      type: "aws_route53_zone",
      name: "primary-zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });

    const estimate = calculateDnsCost(resource, "aws", "us-east-1");

    expect(estimate.resource_id).toBe("aws_route53_zone.primary");
    expect(estimate.resource_type).toBe("aws_route53_zone");
    expect(estimate.resource_name).toBe("primary-zone");
    expect(estimate.region).toBe("us-east-1");
  });

  it("cross-provider targeting: AWS zone resource priced for GCP", () => {
    const resource = makeResource({
      type: "aws_route53_zone",
      provider: "aws",
      attributes: { queries_per_month: 1_000_000 },
    });

    const estimate = calculateDnsCost(resource, "gcp", "us-central1");

    // GCP pricing: $0.20 zone + $0.40 * 1 = $0.60
    expect(estimate.monthly_cost).toBeCloseTo(0.20 + 0.40, 5);
    expect(estimate.provider).toBe("gcp");
  });
});
