import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

// ---------------------------------------------------------------------------
// Default usage assumptions when Terraform attributes are not specified.
// ---------------------------------------------------------------------------

const DEFAULT_LAMBDA_INVOCATIONS_MONTHLY = 1_000_000;
const DEFAULT_LAMBDA_DURATION_MS = 200;
const DEFAULT_LAMBDA_MEMORY_MB = 128;

const DEFAULT_SQS_MESSAGES_MONTHLY = 1_000_000;

const DEFAULT_DYNAMO_READS_MONTHLY = 1_000_000;
const DEFAULT_DYNAMO_WRITES_MONTHLY = 1_000_000;
const DEFAULT_DYNAMO_STORAGE_GB = 1;

// ---------------------------------------------------------------------------
// AWS Lambda pricing (us-east-1 on-demand, 2024)
// ---------------------------------------------------------------------------

const LAMBDA_REQUEST_PRICE_PER_MILLION = 0.20;

// GB-second pricing varies by architecture
const LAMBDA_GB_SECOND_PRICE: Record<string, number> = {
  x86_64: 0.0000166667,
  arm64: 0.0000133334, // Graviton2 is ~20% cheaper
};

/**
 * Calculates the monthly cost for an AWS Lambda function.
 *
 * Cost = (invocations / 1M) * $0.20 + GB-seconds * $0.0000166667
 *
 * GB-seconds = invocations * duration_seconds * memory_gb
 */
export function calculateLambdaCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const memoryMb =
    (resource.attributes.memory_size as number | undefined) ??
    DEFAULT_LAMBDA_MEMORY_MB;
  const timeoutSec =
    (resource.attributes.timeout as number | undefined) ?? 3;
  const architecture =
    (resource.attributes.architecture as string | undefined) ?? "x86_64";

  const invocationsPerMonth =
    (resource.attributes.monthly_invocations as number | undefined) ??
    DEFAULT_LAMBDA_INVOCATIONS_MONTHLY;

  const avgDurationMs =
    (resource.attributes.avg_duration_ms as number | undefined) ??
    DEFAULT_LAMBDA_DURATION_MS;

  const memoryGb = memoryMb / 1024;
  const durationSeconds = avgDurationMs / 1000;

  notes.push(
    `Estimated ${invocationsPerMonth.toLocaleString()} invocations/month, ` +
    `${avgDurationMs}ms avg duration, ${memoryMb}MB memory (${architecture})`
  );

  // Request charges
  const requestCost = (invocationsPerMonth / 1_000_000) * LAMBDA_REQUEST_PRICE_PER_MILLION;
  breakdown.push({
    description: `Lambda requests (${(invocationsPerMonth / 1_000_000).toFixed(1)}M/month)`,
    unit: "1M requests",
    quantity: invocationsPerMonth / 1_000_000,
    unit_price: LAMBDA_REQUEST_PRICE_PER_MILLION,
    monthly_cost: requestCost,
  });

  // Compute charges (GB-seconds)
  const gbSecondsPerMonth = invocationsPerMonth * durationSeconds * memoryGb;
  const gbSecondPrice =
    LAMBDA_GB_SECOND_PRICE[architecture] ?? LAMBDA_GB_SECOND_PRICE["x86_64"]!;
  const computeCost = gbSecondsPerMonth * gbSecondPrice;

  breakdown.push({
    description: `Lambda compute (${gbSecondsPerMonth.toFixed(0)} GB-seconds/month)`,
    unit: "GB-second",
    quantity: gbSecondsPerMonth,
    unit_price: gbSecondPrice,
    monthly_cost: computeCost,
  });

  if (!resource.attributes.monthly_invocations) {
    notes.push(
      `Default invocation assumption: ${DEFAULT_LAMBDA_INVOCATIONS_MONTHLY.toLocaleString()}/month — ` +
      "provide monthly_invocations attribute for accuracy"
    );
  }

  const totalMonthly = requestCost + computeCost;
  void timeoutSec; // captured for reference; not directly used in pricing

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
// AWS DynamoDB pricing
// ---------------------------------------------------------------------------

const DYNAMO_ON_DEMAND_WRITE_PER_MILLION = 1.25;
const DYNAMO_ON_DEMAND_READ_PER_MILLION = 0.25;
const DYNAMO_STORAGE_PER_GB = 0.25;

const DYNAMO_PROVISIONED_WCU_PER_HR = 0.00065;
const DYNAMO_PROVISIONED_RCU_PER_HR = 0.00013;

const MONTHLY_HOURS = 730;

/**
 * Calculates the monthly cost for an AWS DynamoDB table.
 *
 * On-demand:  WCU $1.25/million + RCU $0.25/million + storage $0.25/GB
 * Provisioned: WCU $0.00065/hr + RCU $0.00013/hr + storage $0.25/GB
 */
export function calculateDynamoDbCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const billingMode =
    ((resource.attributes.billing_mode as string | undefined) ?? "PAY_PER_REQUEST").toUpperCase();

  const readCapacity = (resource.attributes.read_capacity as number | undefined) ?? 5;
  const writeCapacity = (resource.attributes.write_capacity as number | undefined) ?? 5;
  const storageGb =
    (resource.attributes.storage_size_gb as number | undefined) ?? DEFAULT_DYNAMO_STORAGE_GB;

  let totalMonthly = 0;

  if (billingMode === "PAY_PER_REQUEST" || billingMode === "ON_DEMAND") {
    const readsMonthly =
      (resource.attributes.monthly_reads as number | undefined) ?? DEFAULT_DYNAMO_READS_MONTHLY;
    const writesMonthly =
      (resource.attributes.monthly_writes as number | undefined) ?? DEFAULT_DYNAMO_WRITES_MONTHLY;

    const writeCost = (writesMonthly / 1_000_000) * DYNAMO_ON_DEMAND_WRITE_PER_MILLION;
    const readCost = (readsMonthly / 1_000_000) * DYNAMO_ON_DEMAND_READ_PER_MILLION;

    breakdown.push({
      description: `DynamoDB on-demand writes (${(writesMonthly / 1_000_000).toFixed(1)}M WCU/month)`,
      unit: "1M WCU",
      quantity: writesMonthly / 1_000_000,
      unit_price: DYNAMO_ON_DEMAND_WRITE_PER_MILLION,
      monthly_cost: writeCost,
    });

    breakdown.push({
      description: `DynamoDB on-demand reads (${(readsMonthly / 1_000_000).toFixed(1)}M RCU/month)`,
      unit: "1M RCU",
      quantity: readsMonthly / 1_000_000,
      unit_price: DYNAMO_ON_DEMAND_READ_PER_MILLION,
      monthly_cost: readCost,
    });

    totalMonthly += writeCost + readCost;

    if (!resource.attributes.monthly_reads && !resource.attributes.monthly_writes) {
      notes.push(
        `Default usage assumption: ${DEFAULT_DYNAMO_READS_MONTHLY.toLocaleString()} reads and ` +
        `${DEFAULT_DYNAMO_WRITES_MONTHLY.toLocaleString()} writes/month (on-demand)`
      );
    }
  } else {
    // PROVISIONED
    const wcuCost = writeCapacity * DYNAMO_PROVISIONED_WCU_PER_HR * MONTHLY_HOURS;
    const rcuCost = readCapacity * DYNAMO_PROVISIONED_RCU_PER_HR * MONTHLY_HOURS;

    breakdown.push({
      description: `DynamoDB provisioned write capacity (${writeCapacity} WCU)`,
      unit: "WCU-Hr",
      quantity: writeCapacity * MONTHLY_HOURS,
      unit_price: DYNAMO_PROVISIONED_WCU_PER_HR,
      monthly_cost: wcuCost,
    });

    breakdown.push({
      description: `DynamoDB provisioned read capacity (${readCapacity} RCU)`,
      unit: "RCU-Hr",
      quantity: readCapacity * MONTHLY_HOURS,
      unit_price: DYNAMO_PROVISIONED_RCU_PER_HR,
      monthly_cost: rcuCost,
    });

    totalMonthly += wcuCost + rcuCost;
    notes.push(`Provisioned billing mode: ${writeCapacity} WCU, ${readCapacity} RCU`);
  }

  // Storage
  const storageCost = storageGb * DYNAMO_STORAGE_PER_GB;
  breakdown.push({
    description: `DynamoDB storage (${storageGb} GB)`,
    unit: "GB-Mo",
    quantity: storageGb,
    unit_price: DYNAMO_STORAGE_PER_GB,
    monthly_cost: storageCost,
  });
  totalMonthly += storageCost;

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
// AWS SQS pricing
// ---------------------------------------------------------------------------

const SQS_STANDARD_PER_MILLION = 0.40;
const SQS_FIFO_PER_MILLION = 0.50;

/**
 * Calculates the monthly cost for an AWS SQS queue.
 *
 * Standard: $0.40/million requests
 * FIFO:     $0.50/million requests
 */
export function calculateSqsCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const isFifo = Boolean(resource.attributes.fifo_queue);
  const messagesPerMonth =
    (resource.attributes.monthly_messages as number | undefined) ??
    DEFAULT_SQS_MESSAGES_MONTHLY;

  const pricePerMillion = isFifo ? SQS_FIFO_PER_MILLION : SQS_STANDARD_PER_MILLION;
  const queueType = isFifo ? "FIFO" : "Standard";
  const totalMonthly = (messagesPerMonth / 1_000_000) * pricePerMillion;

  breakdown.push({
    description: `SQS ${queueType} queue (${(messagesPerMonth / 1_000_000).toFixed(1)}M messages/month)`,
    unit: "1M requests",
    quantity: messagesPerMonth / 1_000_000,
    unit_price: pricePerMillion,
    monthly_cost: totalMonthly,
  });

  if (!resource.attributes.monthly_messages) {
    notes.push(
      `Default assumption: ${DEFAULT_SQS_MESSAGES_MONTHLY.toLocaleString()} messages/month — ` +
      "provide monthly_messages attribute for accuracy"
    );
  }

  notes.push(`SQS ${queueType} queue pricing at $${pricePerMillion}/million requests`);

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
