import { describe, it, expect } from "vitest";
import {
  calculateMessagingCost,
  calculateMqBrokerCost,
  calculateEventHubCost,
  calculatePubSubSubscriptionCost,
} from "../../../src/calculator/messaging.js";
import { makeResource } from "../../helpers/factories.js";

describe("calculateMessagingCost", () => {
  // -------------------------------------------------------------------------
  // AWS SNS
  // -------------------------------------------------------------------------

  describe("AWS SNS", () => {
    it("should include only HTTP delivery cost when within 1M free tier", () => {
      const resource = makeResource({
        type: "aws_sns_topic",
        attributes: { monthly_messages: 500_000 },
      });

      const estimate = calculateMessagingCost(resource, "aws", "us-east-1");

      // Publish: 0 billable (within 1M free), HTTP delivery: 500K / 100K * $0.06 = $0.30
      expect(estimate.monthly_cost).toBeCloseTo(0.3, 2);
      expect(estimate.confidence).toBe("high");
      expect(estimate.notes.some((n) => n.includes("free tier"))).toBe(true);
    });

    it("should charge for publish requests above 1M free tier plus delivery", () => {
      const resource = makeResource({
        type: "aws_sns_topic",
        attributes: { monthly_messages: 5_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "aws", "us-east-1");

      // Publish: (5M - 1M) = 4M / 1M * $0.50 = $2.00
      // HTTP delivery: 5M / 100K * $0.06 = $3.00
      // Total: $5.00
      expect(estimate.monthly_cost).toBeCloseTo(5.0, 2);
      expect(estimate.breakdown.length).toBe(2);
    });

    it("should assume 1M messages/month when not specified", () => {
      const resource = makeResource({
        type: "aws_sns_topic",
        attributes: {},
      });

      const estimate = calculateMessagingCost(resource, "aws", "us-east-1");

      // 1M is within free tier for publish, delivery: 1M / 100K * $0.06 = $0.60
      expect(estimate.monthly_cost).toBeCloseTo(0.6, 2);
      expect(estimate.confidence).toBe("medium");
      expect(estimate.notes.some((n) => n.includes("assuming"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Azure Service Bus
  // -------------------------------------------------------------------------

  describe("Azure Service Bus", () => {
    it("should calculate Basic tier cost per million operations", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_servicebus_namespace",
        attributes: { sku: "Basic", monthly_messages: 10_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "azure", "eastus");

      // 10M / 1M * $0.05 = $0.50
      expect(estimate.monthly_cost).toBeCloseTo(0.5, 2);
      expect(estimate.provider).toBe("azure");
    });

    it("should calculate Standard tier cost with base fee plus operations", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_servicebus_namespace",
        attributes: { sku: "Standard", monthly_messages: 10_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "azure", "eastus");

      // Base: $10.00 + 10M / 1M * $13.30 = $10.00 + $133.00 = $143.00
      expect(estimate.monthly_cost).toBeCloseTo(143.0, 0);
      expect(estimate.breakdown.length).toBe(2);
    });

    it("should treat Premium tier like Standard tier", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_servicebus_namespace",
        attributes: { sku: "Premium", monthly_messages: 1_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "azure", "eastus");

      // Base: $10.00 + 1M / 1M * $13.30 = $23.30
      expect(estimate.monthly_cost).toBeCloseTo(23.3, 1);
    });

    it("should default to Basic tier when sku is not specified", () => {
      const resource = makeResource({
        provider: "azure",
        type: "azurerm_servicebus_namespace",
        attributes: { monthly_messages: 1_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "azure", "eastus");

      // Basic: 1M / 1M * $0.05 = $0.05
      expect(estimate.monthly_cost).toBeCloseTo(0.05, 2);
    });
  });

  // -------------------------------------------------------------------------
  // GCP Pub/Sub
  // -------------------------------------------------------------------------

  describe("GCP Pub/Sub", () => {
    it("should cost zero when data is within 10 GiB free tier", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_pubsub_topic",
        attributes: { monthly_data_gb: 5 },
      });

      const estimate = calculateMessagingCost(resource, "gcp", "us-central1");

      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.notes.some((n) => n.includes("free tier"))).toBe(true);
    });

    it("should charge $40/TiB for data above free tier", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_pubsub_topic",
        attributes: { monthly_data_gb: 1034 },
      });

      const estimate = calculateMessagingCost(resource, "gcp", "us-central1");

      // (1034 - 10) = 1024 GiB billable = 1 TiB * $40 = $40.00
      expect(estimate.monthly_cost).toBeCloseTo(40.0, 1);
    });

    it("should default to 1 GiB/month data when not specified", () => {
      const resource = makeResource({
        provider: "gcp",
        type: "google_pubsub_topic",
        attributes: {},
      });

      const estimate = calculateMessagingCost(resource, "gcp", "us-central1");

      // 1 GiB is within 10 GiB free tier
      expect(estimate.monthly_cost).toBe(0);
      expect(estimate.confidence).toBe("medium");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle zero messages for AWS", () => {
      const resource = makeResource({
        attributes: { monthly_messages: 0 },
      });

      const estimate = calculateMessagingCost(resource, "aws", "us-east-1");

      expect(estimate.monthly_cost).toBe(0);
    });

    it("should set yearly_cost to 12x monthly_cost", () => {
      const resource = makeResource({
        attributes: { monthly_messages: 5_000_000 },
      });

      const estimate = calculateMessagingCost(resource, "aws", "us-east-1");

      expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// calculateMqBrokerCost
// ---------------------------------------------------------------------------

describe("calculateMqBrokerCost", () => {
  it("should calculate cost for a known instance type", () => {
    const resource = makeResource({
      type: "aws_mq_broker",
      attributes: { instance_type: "mq.m5.large", engine_type: "ActiveMQ" },
    });

    const estimate = calculateMqBrokerCost(resource, "aws", "us-east-1");

    // Instance: $0.30/hr * 730h = $219.00 + Storage: 20 GB * $0.10 = $2.00 = $221.00
    expect(estimate.monthly_cost).toBeCloseTo(221.0, 0);
    expect(estimate.confidence).toBe("medium");
  });

  it("should double instance cost for ACTIVE_STANDBY_MULTI_AZ", () => {
    const resource = makeResource({
      type: "aws_mq_broker",
      attributes: {
        instance_type: "mq.m5.large",
        deployment_mode: "ACTIVE_STANDBY_MULTI_AZ",
      },
    });

    const estimate = calculateMqBrokerCost(resource, "aws", "us-east-1");

    // Instance: $0.30/hr * 730h * 2 = $438.00 + Storage: 20 GB * $0.10 = $2.00 = $440.00
    expect(estimate.monthly_cost).toBeCloseTo(440.0, 0);
  });

  it("should report low confidence for unknown instance type", () => {
    const resource = makeResource({
      type: "aws_mq_broker",
      attributes: { instance_type: "mq.unknown.type" },
    });

    const estimate = calculateMqBrokerCost(resource, "aws", "us-east-1");

    // Unknown instance = $0 instance cost, only storage: 20 GB * $0.10 = $2.00
    expect(estimate.monthly_cost).toBeCloseTo(2.0, 2);
    expect(estimate.confidence).toBe("low");
  });

  it("should use custom storage size", () => {
    const resource = makeResource({
      type: "aws_mq_broker",
      attributes: { instance_type: "mq.t3.micro", storage_size_gb: 100 },
    });

    const estimate = calculateMqBrokerCost(resource, "aws", "us-east-1");

    // Instance: $0.03/hr * 730h = $21.90 + Storage: 100 GB * $0.10 = $10.00 = $31.90
    expect(estimate.monthly_cost).toBeCloseTo(31.9, 0);
  });
});

// ---------------------------------------------------------------------------
// calculateEventHubCost
// ---------------------------------------------------------------------------

describe("calculateEventHubCost", () => {
  it("should calculate Standard tier cost", () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_eventhub_namespace",
      attributes: { sku: "Standard", capacity: 2 },
    });

    const estimate = calculateEventHubCost(resource, "azure", "eastus");

    // $0.03/TU/hr * 2 TU * 730h = $43.80
    expect(estimate.monthly_cost).toBeCloseTo(43.8, 1);
    expect(estimate.provider).toBe("azure");
  });

  it("should calculate Basic tier cost", () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_eventhub_namespace",
      attributes: { sku: "Basic", capacity: 1 },
    });

    const estimate = calculateEventHubCost(resource, "azure", "eastus");

    // $0.015/TU/hr * 1 TU * 730h = $10.95
    expect(estimate.monthly_cost).toBeCloseTo(10.95, 1);
  });

  it("should calculate Premium tier cost using PU label", () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_eventhub_namespace",
      attributes: { sku: "Premium", capacity: 1 },
    });

    const estimate = calculateEventHubCost(resource, "azure", "eastus");

    // $0.12/PU/hr * 1 PU * 730h = $87.60
    expect(estimate.monthly_cost).toBeCloseTo(87.6, 1);
  });

  it("should default to Standard tier and 1 TU when attributes are missing", () => {
    const resource = makeResource({
      provider: "azure",
      type: "azurerm_eventhub_namespace",
      attributes: {},
    });

    const estimate = calculateEventHubCost(resource, "azure", "eastus");

    // Standard default: $0.03/hr * 1 * 730h = $21.90
    expect(estimate.monthly_cost).toBeCloseTo(21.9, 1);
  });
});

// ---------------------------------------------------------------------------
// calculatePubSubSubscriptionCost
// ---------------------------------------------------------------------------

describe("calculatePubSubSubscriptionCost", () => {
  it("should calculate ack operation cost at $0.04/million", () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_pubsub_subscription",
      attributes: { monthly_messages: 10_000_000 },
    });

    const estimate = calculatePubSubSubscriptionCost(resource, "gcp", "us-central1");

    // 10M / 1M * $0.04 = $0.40
    expect(estimate.monthly_cost).toBeCloseTo(0.4, 2);
    expect(estimate.confidence).toBe("high");
  });

  it("should default to 1M ack operations when not specified", () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_pubsub_subscription",
      attributes: {},
    });

    const estimate = calculatePubSubSubscriptionCost(resource, "gcp", "us-central1");

    // 1M / 1M * $0.04 = $0.04
    expect(estimate.monthly_cost).toBeCloseTo(0.04, 2);
    expect(estimate.confidence).toBe("medium");
  });
});
