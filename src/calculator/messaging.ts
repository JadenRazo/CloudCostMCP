import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default usage assumptions
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGES_PER_MONTH = 1_000_000;
const DEFAULT_DATA_TRANSFER_GB = 1;
const MONTHLY_HOURS = 730;

// ---------------------------------------------------------------------------
// AWS MQ pricing (us-east-1 on-demand, 2024)
// ---------------------------------------------------------------------------

const AWS_MQ_INSTANCE_PRICES: Record<string, number> = {
  "mq.t3.micro": 0.03,
  "mq.m5.large": 0.3,
  "mq.m5.xlarge": 0.6,
  "mq.m5.2xlarge": 1.2,
  "mq.m5.4xlarge": 2.4,
};

// Storage: $0.10/GB/month for EBS
const AWS_MQ_STORAGE_PER_GB = 0.1;
const AWS_MQ_DEFAULT_STORAGE_GB = 20;

// ---------------------------------------------------------------------------
// Azure Event Hubs pricing (2024)
// ---------------------------------------------------------------------------

// Basic: ~$0.015/TU/hr, Standard: ~$0.03/TU/hr, Premium: ~$0.12/PU/hr
const AZURE_EVENTHUB_TIER_PRICES: Record<string, number> = {
  basic: 0.015,
  standard: 0.03,
  premium: 0.12,
};

// ---------------------------------------------------------------------------
// GCP Pub/Sub Subscription pricing (2024)
// ---------------------------------------------------------------------------

// $0.04 per 1,000,000 message acknowledgements (operations)
const GCP_PUBSUB_SUBSCRIPTION_PER_MILLION_OPS = 0.04;

// ---------------------------------------------------------------------------
// AWS SNS pricing (us-east-1, 2024)
// ---------------------------------------------------------------------------

// First 1M requests/month free, then $0.50/million
const AWS_SNS_PER_MILLION_REQUESTS = 0.5;
const AWS_SNS_FREE_TIER_REQUESTS = 1_000_000;

// HTTP/S delivery: $0.06/100,000 notifications
const AWS_SNS_HTTP_PER_100K = 0.06;

// ---------------------------------------------------------------------------
// Azure Service Bus pricing (2024)
// ---------------------------------------------------------------------------

// Basic tier: $0.05/million operations (first 13M included at ~$0.0133/1K)
const AZURE_SERVICE_BUS_BASIC_MONTHLY = 0.0;
const AZURE_SERVICE_BUS_BASIC_PER_MILLION_OPS = 0.05;

// Standard tier: $10/month base + $0.0133 per 1,000 operations (above 13M)
const AZURE_SERVICE_BUS_STANDARD_MONTHLY = 10.0;
const AZURE_SERVICE_BUS_STANDARD_PER_MILLION_OPS = 13.3;

// ---------------------------------------------------------------------------
// GCP Pub/Sub pricing (2024)
// ---------------------------------------------------------------------------

// $40/TiB of message data delivered
const GCP_PUBSUB_PER_TIB = 40.0;

// First 10 GiB free per month
const GCP_PUBSUB_FREE_TIER_GIB = 10;

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for a messaging/notification resource.
 *
 * AWS SNS: first 1M free, then $0.50/million requests + delivery charges
 * Azure Service Bus: tier-based pricing (Basic/Standard)
 * GCP Pub/Sub: $40/TiB of message data
 */
export function calculateMessagingCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const messagesPerMonth =
    (resource.attributes.monthly_messages as number | undefined) ?? DEFAULT_MESSAGES_PER_MONTH;

  const hasExplicitMessages = resource.attributes.monthly_messages !== undefined;

  if (!hasExplicitMessages) {
    notes.push(
      `No monthly_messages specified; assuming ${DEFAULT_MESSAGES_PER_MONTH.toLocaleString()} messages/month`,
    );
  }

  let totalMonthly = 0;

  if (targetProvider === "aws") {
    // SNS publish requests
    const billableRequests = Math.max(0, messagesPerMonth - AWS_SNS_FREE_TIER_REQUESTS);
    const requestCost = (billableRequests / 1_000_000) * AWS_SNS_PER_MILLION_REQUESTS;

    breakdown.push({
      description: `SNS publish requests (${messagesPerMonth.toLocaleString()} total, ${billableRequests.toLocaleString()} billable)`,
      unit: "1M requests",
      quantity: billableRequests / 1_000_000,
      unit_price: AWS_SNS_PER_MILLION_REQUESTS,
      monthly_cost: requestCost,
    });
    totalMonthly += requestCost;

    // HTTP/S notification delivery
    const httpDeliveryCost = (messagesPerMonth / 100_000) * AWS_SNS_HTTP_PER_100K;
    breakdown.push({
      description: `SNS HTTP/S delivery (${messagesPerMonth.toLocaleString()} notifications)`,
      unit: "100K notifications",
      quantity: messagesPerMonth / 100_000,
      unit_price: AWS_SNS_HTTP_PER_100K,
      monthly_cost: httpDeliveryCost,
    });
    totalMonthly += httpDeliveryCost;

    if (messagesPerMonth <= AWS_SNS_FREE_TIER_REQUESTS) {
      notes.push("All publish requests within AWS SNS free tier (1M requests/month)");
    } else {
      notes.push(
        `AWS SNS: first ${AWS_SNS_FREE_TIER_REQUESTS.toLocaleString()} publishes free, then $${AWS_SNS_PER_MILLION_REQUESTS}/million`,
      );
    }
  } else if (targetProvider === "azure") {
    const tier = ((resource.attributes.sku as string | undefined) ?? "basic").toLowerCase();

    if (tier === "standard" || tier === "premium") {
      // Standard tier
      breakdown.push({
        description: "Service Bus Standard tier base fee",
        unit: "Mo",
        quantity: 1,
        unit_price: AZURE_SERVICE_BUS_STANDARD_MONTHLY,
        monthly_cost: AZURE_SERVICE_BUS_STANDARD_MONTHLY,
      });
      totalMonthly += AZURE_SERVICE_BUS_STANDARD_MONTHLY;

      const opsCost = (messagesPerMonth / 1_000_000) * AZURE_SERVICE_BUS_STANDARD_PER_MILLION_OPS;
      breakdown.push({
        description: `Service Bus operations (${(messagesPerMonth / 1_000_000).toFixed(1)}M ops/month)`,
        unit: "1M ops",
        quantity: messagesPerMonth / 1_000_000,
        unit_price: AZURE_SERVICE_BUS_STANDARD_PER_MILLION_OPS,
        monthly_cost: opsCost,
      });
      totalMonthly += opsCost;

      notes.push(
        `Azure Service Bus Standard tier: $${AZURE_SERVICE_BUS_STANDARD_MONTHLY}/month base`,
      );
    } else {
      // Basic tier
      void AZURE_SERVICE_BUS_BASIC_MONTHLY; // no base fee
      const opsCost = (messagesPerMonth / 1_000_000) * AZURE_SERVICE_BUS_BASIC_PER_MILLION_OPS;
      breakdown.push({
        description: `Service Bus Basic operations (${(messagesPerMonth / 1_000_000).toFixed(1)}M ops/month)`,
        unit: "1M ops",
        quantity: messagesPerMonth / 1_000_000,
        unit_price: AZURE_SERVICE_BUS_BASIC_PER_MILLION_OPS,
        monthly_cost: opsCost,
      });
      totalMonthly += opsCost;

      notes.push(
        `Azure Service Bus Basic tier: $${AZURE_SERVICE_BUS_BASIC_PER_MILLION_OPS}/million operations`,
      );
    }
  } else {
    // gcp - Pub/Sub
    const dataTransferGb =
      (resource.attributes.monthly_data_gb as number | undefined) ?? DEFAULT_DATA_TRANSFER_GB;

    const billableGib = Math.max(0, dataTransferGb - GCP_PUBSUB_FREE_TIER_GIB);
    // Convert GiB to TiB for pricing
    const billableTib = billableGib / 1024;
    const dataCost = billableTib * GCP_PUBSUB_PER_TIB;

    breakdown.push({
      description: `Pub/Sub message delivery (${dataTransferGb} GiB total, ${billableGib.toFixed(1)} GiB billable)`,
      unit: "TiB",
      quantity: billableTib,
      unit_price: GCP_PUBSUB_PER_TIB,
      monthly_cost: dataCost,
    });
    totalMonthly += dataCost;

    if (dataTransferGb <= GCP_PUBSUB_FREE_TIER_GIB) {
      notes.push(`All data within GCP Pub/Sub free tier (${GCP_PUBSUB_FREE_TIER_GIB} GiB/month)`);
    } else {
      notes.push(
        `GCP Pub/Sub: first ${GCP_PUBSUB_FREE_TIER_GIB} GiB free, then $${GCP_PUBSUB_PER_TIB}/TiB`,
      );
    }

    if (!resource.attributes.monthly_data_gb) {
      notes.push(
        `Default data assumption: ${DEFAULT_DATA_TRANSFER_GB} GiB/month — provide monthly_data_gb for accuracy`,
      );
    }
  }

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: hasExplicitMessages ? "high" : "medium",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// AWS MQ Broker
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for an AWS MQ broker.
 *
 * Cost = instance_hourly_price * monthly_hours + storage_gb * storage_rate
 * Supports ActiveMQ and RabbitMQ engines.
 */
export function calculateMqBrokerCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const instanceType = (resource.attributes.instance_type as string | undefined) ?? "mq.m5.large";
  const engine = (resource.attributes.engine_type as string | undefined) ?? "ActiveMQ";
  const deploymentMode =
    (resource.attributes.deployment_mode as string | undefined) ?? "SINGLE_INSTANCE";
  const storageGb =
    (resource.attributes.storage_size_gb as number | undefined) ?? AWS_MQ_DEFAULT_STORAGE_GB;

  const instanceMultiplier = deploymentMode === "ACTIVE_STANDBY_MULTI_AZ" ? 2 : 1;

  const hourlyPrice = AWS_MQ_INSTANCE_PRICES[instanceType.toLowerCase()];
  let totalMonthly = 0;

  if (hourlyPrice !== undefined) {
    const instanceCost = hourlyPrice * MONTHLY_HOURS * instanceMultiplier;
    totalMonthly += instanceCost;

    breakdown.push({
      description: `MQ ${engine} broker ${instanceType} x${instanceMultiplier} (${MONTHLY_HOURS}h/month)`,
      unit: "Hrs",
      quantity: instanceMultiplier * MONTHLY_HOURS,
      unit_price: hourlyPrice,
      monthly_cost: instanceCost,
    });

    notes.push(`AWS MQ ${engine}: ${instanceType}, ${deploymentMode}`);
  } else {
    notes.push(
      `No pricing data found for MQ instance type ${instanceType}; instance cost reported as $0`,
    );
  }

  // Storage cost
  const storageCost = storageGb * AWS_MQ_STORAGE_PER_GB;
  totalMonthly += storageCost;

  breakdown.push({
    description: `MQ EBS storage (${storageGb} GB)`,
    unit: "GB-Mo",
    quantity: storageGb,
    unit_price: AWS_MQ_STORAGE_PER_GB,
    monthly_cost: storageCost,
  });

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: hourlyPrice !== undefined ? "medium" : "low",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// Azure Event Hubs
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for an Azure Event Hubs namespace.
 *
 * Pricing is based on throughput units (TUs) or processing units (PUs).
 * Basic: $0.015/TU/hr, Standard: $0.03/TU/hr, Premium: $0.12/PU/hr
 */
export function calculateEventHubCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const sku = ((resource.attributes.sku as string | undefined) ?? "Standard").toLowerCase();
  const capacity = (resource.attributes.capacity as number | undefined) ?? 1;

  const hourlyPrice = AZURE_EVENTHUB_TIER_PRICES[sku] ?? AZURE_EVENTHUB_TIER_PRICES["standard"]!;
  const unitLabel = sku === "premium" ? "PU" : "TU";

  const totalMonthly = hourlyPrice * capacity * MONTHLY_HOURS;

  breakdown.push({
    description: `Event Hubs ${sku} ${capacity} ${unitLabel}(s) (${MONTHLY_HOURS}h/month)`,
    unit: "Hrs",
    quantity: capacity * MONTHLY_HOURS,
    unit_price: hourlyPrice,
    monthly_cost: totalMonthly,
  });

  notes.push(
    `Azure Event Hubs: ${sku} tier, ${capacity} ${unitLabel}(s) — $${hourlyPrice}/${unitLabel}/hr`,
  );

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: totalMonthly,
    yearly_cost: totalMonthly * 12,
    currency: "USD",
    breakdown,
    confidence: "medium",
    notes,
    pricing_source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// GCP Pub/Sub Subscription
// ---------------------------------------------------------------------------

/**
 * Calculates the monthly cost for a GCP Pub/Sub subscription.
 *
 * $0.04 per 1,000,000 message acknowledgements.
 * Subscription delivery costs are separate from topic publish costs.
 */
export function calculatePubSubSubscriptionCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string,
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const messagesPerMonth =
    (resource.attributes.monthly_messages as number | undefined) ?? DEFAULT_MESSAGES_PER_MONTH;
  const hasExplicitMessages = resource.attributes.monthly_messages !== undefined;

  if (!hasExplicitMessages) {
    notes.push(
      `No monthly_messages specified; assuming ${DEFAULT_MESSAGES_PER_MONTH.toLocaleString()} ack operations/month`,
    );
  }

  const opsCost = (messagesPerMonth / 1_000_000) * GCP_PUBSUB_SUBSCRIPTION_PER_MILLION_OPS;

  breakdown.push({
    description: `Pub/Sub subscription ack operations (${(messagesPerMonth / 1_000_000).toFixed(1)}M/month)`,
    unit: "1M ops",
    quantity: messagesPerMonth / 1_000_000,
    unit_price: GCP_PUBSUB_SUBSCRIPTION_PER_MILLION_OPS,
    monthly_cost: opsCost,
  });

  notes.push(
    `GCP Pub/Sub subscription: $${GCP_PUBSUB_SUBSCRIPTION_PER_MILLION_OPS}/million ack operations`,
  );

  return {
    resource_id: resource.id,
    resource_type: resource.type,
    resource_name: resource.name,
    provider: targetProvider,
    region: targetRegion,
    monthly_cost: opsCost,
    yearly_cost: opsCost * 12,
    currency: "USD",
    breakdown,
    confidence: hasExplicitMessages ? "high" : "medium",
    notes,
    pricing_source: "fallback",
  };
}
