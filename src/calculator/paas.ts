import type { ParsedResource } from "../types/resources.js";
import type { CloudProvider } from "../types/resources.js";
import type { CostEstimate, CostLineItem } from "../types/pricing.js";

const MONTHLY_HOURS = 730;

// ---------------------------------------------------------------------------
// Azure App Service Plan pricing
// ---------------------------------------------------------------------------

// Hourly price by sku_name (new provider) or tier+size (old provider)
const APP_SERVICE_PRICES: Record<string, number> = {
  // Free / Shared
  "f1": 0.0,
  "free": 0.0,
  "d1": 0.013,
  "shared": 0.013,
  // Basic
  "b1": 0.075,
  "b2": 0.15,
  "b3": 0.30,
  // Standard
  "s1": 0.10,
  "s2": 0.20,
  "s3": 0.40,
  // Premium v2
  "p1v2": 0.20,
  "p2v2": 0.40,
  "p3v2": 0.80,
  // Premium v3
  "p1v3": 0.175,
  "p2v3": 0.35,
  "p3v3": 0.70,
  // Isolated
  "i1": 0.30,
  "i2": 0.60,
  "i3": 1.20,
};

/**
 * Calculates the monthly cost for an Azure App Service Plan.
 *
 * Supports both old (sku block with tier+size) and new (sku_name) provider syntax.
 */
export function calculateAppServicePlanCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  // Resolve SKU — new provider uses sku_name; old uses sku_tier + sku_size
  const skuName = (resource.attributes.sku as string | undefined) ?? "";
  const skuTier = ((resource.attributes.sku_tier as string | undefined) ?? "").toLowerCase();
  const skuSize = ((resource.attributes.sku_size as string | undefined) ?? "").toLowerCase();

  // Normalize to a simple lookup key
  let lookupKey = skuName.toLowerCase().replace(/\s+/g, "");

  if (!lookupKey && skuSize) {
    lookupKey = skuSize;
  }

  const hourlyPrice = APP_SERVICE_PRICES[lookupKey] ?? APP_SERVICE_PRICES[skuTier];
  let totalMonthly = 0;
  let pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (hourlyPrice !== undefined) {
    totalMonthly = hourlyPrice * MONTHLY_HOURS;

    if (totalMonthly === 0) {
      notes.push(`App Service Plan ${skuName || skuSize || skuTier} is on the free tier ($0/month)`);
    } else {
      breakdown.push({
        description: `App Service Plan ${skuName || skuSize || skuTier} (${MONTHLY_HOURS}h/month)`,
        unit: "Hrs",
        quantity: MONTHLY_HOURS,
        unit_price: hourlyPrice,
        monthly_cost: totalMonthly,
      });
    }

    pricingSource = "fallback";
    notes.push(`Azure App Service Plan: SKU ${skuName || `${skuTier} ${skuSize}`}`);
  } else {
    notes.push(
      `No pricing found for App Service Plan SKU "${skuName || skuSize || skuTier}"; cost reported as $0`
    );
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
    confidence: hourlyPrice !== undefined ? "medium" : "low",
    notes,
    pricing_source: pricingSource,
  };
}

// ---------------------------------------------------------------------------
// Azure Cosmos DB pricing
// ---------------------------------------------------------------------------

// Serverless: $0.25/million RU
const COSMOS_SERVERLESS_PER_MILLION_RU = 0.25;
// Provisioned: $0.008/hr per 100 RU/s
const COSMOS_PROVISIONED_PER_100_RU_PER_HR = 0.008;
// Storage: $0.25/GB/month
const COSMOS_STORAGE_PER_GB = 0.25;
const DEFAULT_COSMOS_PROVISIONED_RU = 400;
const DEFAULT_COSMOS_SERVERLESS_RU_MILLION = 1;

/**
 * Calculates the monthly cost for an Azure Cosmos DB account.
 *
 * Serverless: $0.25/million RU consumed
 * Provisioned: $0.008/hr per 100 RU/s + $0.25/GB storage
 */
export function calculateCosmosDbCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const offerType = ((resource.attributes.offer_type as string | undefined) ?? "Standard").toLowerCase();
  const capabilities = resource.attributes.capabilities as string[] | undefined;
  const isServerless = capabilities?.includes("EnableServerless") || offerType === "serverless";

  const throughput = (resource.attributes.throughput as number | undefined);

  let totalMonthly = 0;
  const pricingSource: "live" | "fallback" | "bundled" = "fallback";

  if (isServerless) {
    const ruMillions = DEFAULT_COSMOS_SERVERLESS_RU_MILLION;
    const ruCost = ruMillions * COSMOS_SERVERLESS_PER_MILLION_RU;
    totalMonthly = ruCost;

    breakdown.push({
      description: `Cosmos DB serverless (${ruMillions}M RU/month assumed)`,
      unit: "1M RU",
      quantity: ruMillions,
      unit_price: COSMOS_SERVERLESS_PER_MILLION_RU,
      monthly_cost: ruCost,
    });

    notes.push(
      `Cosmos DB serverless — assuming ${DEFAULT_COSMOS_SERVERLESS_RU_MILLION}M RU/month; ` +
      "provide actual usage for accuracy"
    );
  } else {
    const ruS = throughput ?? DEFAULT_COSMOS_PROVISIONED_RU;
    // Cost = (RU/s / 100) * $0.008/hr * 730 hrs
    const provisionedCost = (ruS / 100) * COSMOS_PROVISIONED_PER_100_RU_PER_HR * MONTHLY_HOURS;
    totalMonthly = provisionedCost;

    breakdown.push({
      description: `Cosmos DB provisioned throughput (${ruS} RU/s)`,
      unit: "100 RU/s-Hr",
      quantity: (ruS / 100) * MONTHLY_HOURS,
      unit_price: COSMOS_PROVISIONED_PER_100_RU_PER_HR,
      monthly_cost: provisionedCost,
    });

    if (!throughput) {
      notes.push(`Default throughput assumption: ${DEFAULT_COSMOS_PROVISIONED_RU} RU/s`);
    }

    notes.push(`Cosmos DB provisioned: ${ruS} RU/s`);
  }

  // Storage estimate
  const storageGb = (resource.attributes.storage_size_gb as number | undefined) ?? 1;
  const storageCost = storageGb * COSMOS_STORAGE_PER_GB;
  if (storageCost > 0) {
    breakdown.push({
      description: `Cosmos DB storage (${storageGb}GB)`,
      unit: "GB-Mo",
      quantity: storageGb,
      unit_price: COSMOS_STORAGE_PER_GB,
      monthly_cost: storageCost,
    });
    totalMonthly += storageCost;
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
    confidence: "medium",
    notes,
    pricing_source: pricingSource,
  };
}

// ---------------------------------------------------------------------------
// Azure Function App pricing (Consumption plan)
// ---------------------------------------------------------------------------

const AZURE_FUNC_PER_MILLION_EXECUTIONS = 0.20;
const AZURE_FUNC_GB_SECOND_PRICE = 0.000016;
const DEFAULT_AZURE_FUNC_EXECUTIONS = 1_000_000;
const DEFAULT_AZURE_FUNC_DURATION_MS = 200;
const DEFAULT_AZURE_FUNC_MEMORY_MB = 128;

/**
 * Calculates the monthly cost for an Azure Function App (Consumption plan).
 *
 * Cost = $0.20/million executions + $0.000016/GB-second
 */
export function calculateAzureFunctionCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const executions =
    (resource.attributes.monthly_executions as number | undefined) ??
    DEFAULT_AZURE_FUNC_EXECUTIONS;
  const durationMs =
    (resource.attributes.avg_duration_ms as number | undefined) ??
    DEFAULT_AZURE_FUNC_DURATION_MS;
  const memoryMb =
    (resource.attributes.memory_size as number | undefined) ??
    DEFAULT_AZURE_FUNC_MEMORY_MB;

  const executionCost = (executions / 1_000_000) * AZURE_FUNC_PER_MILLION_EXECUTIONS;
  const gbSeconds = executions * (durationMs / 1000) * (memoryMb / 1024);
  const computeCost = gbSeconds * AZURE_FUNC_GB_SECOND_PRICE;

  const totalMonthly = executionCost + computeCost;

  breakdown.push({
    description: `Azure Function executions (${(executions / 1_000_000).toFixed(1)}M/month)`,
    unit: "1M executions",
    quantity: executions / 1_000_000,
    unit_price: AZURE_FUNC_PER_MILLION_EXECUTIONS,
    monthly_cost: executionCost,
  });

  breakdown.push({
    description: `Azure Function compute (${gbSeconds.toFixed(0)} GB-seconds/month)`,
    unit: "GB-second",
    quantity: gbSeconds,
    unit_price: AZURE_FUNC_GB_SECOND_PRICE,
    monthly_cost: computeCost,
  });

  if (!resource.attributes.monthly_executions) {
    notes.push(
      `Default assumption: ${DEFAULT_AZURE_FUNC_EXECUTIONS.toLocaleString()} executions/month, ` +
      `${DEFAULT_AZURE_FUNC_DURATION_MS}ms avg duration, ${DEFAULT_AZURE_FUNC_MEMORY_MB}MB memory`
    );
  }

  notes.push("Azure Function App on Consumption plan (dedicated plan not priced separately)");

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
// Google Cloud Run pricing
// ---------------------------------------------------------------------------

const CLOUD_RUN_VCPU_PER_SECOND = 0.00002400;
const CLOUD_RUN_MEMORY_GIB_PER_SECOND = 0.00000250;
const DEFAULT_CLOUD_RUN_REQUESTS = 1_000_000;
const DEFAULT_CLOUD_RUN_DURATION_MS = 200;
const DEFAULT_CLOUD_RUN_VCPUS = 1;
const DEFAULT_CLOUD_RUN_MEMORY_GIB = 0.5;

/**
 * Parses a Cloud Run resource limit string like "1000m" (milli-CPUs) or "512Mi" into
 * a floating-point vCPU/GiB number.
 */
function parseCpuLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_CLOUD_RUN_VCPUS;
  if (raw.endsWith("m")) return parseFloat(raw) / 1000;
  return parseFloat(raw) || DEFAULT_CLOUD_RUN_VCPUS;
}

function parseMemoryLimitGiB(raw: string | undefined): number {
  if (!raw) return DEFAULT_CLOUD_RUN_MEMORY_GIB;
  if (raw.endsWith("Gi")) return parseFloat(raw);
  if (raw.endsWith("Mi")) return parseFloat(raw) / 1024;
  if (raw.endsWith("G")) return parseFloat(raw);
  if (raw.endsWith("M")) return parseFloat(raw) / 1024;
  return parseFloat(raw) / 1024 / 1024 || DEFAULT_CLOUD_RUN_MEMORY_GIB;
}

/**
 * Calculates the monthly cost for a Google Cloud Run service.
 *
 * Cost = vCPU-seconds * $0.00002400 + GiB-seconds * $0.00000250
 */
export function calculateCloudRunCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const cpuRaw = resource.attributes.cpu as string | undefined;
  const memoryRaw = resource.attributes.memory as string | undefined;

  const vcpus = parseCpuLimit(cpuRaw);
  const memoryGib = parseMemoryLimitGiB(memoryRaw);

  const requestsPerMonth =
    (resource.attributes.monthly_requests as number | undefined) ??
    DEFAULT_CLOUD_RUN_REQUESTS;
  const avgDurationMs =
    (resource.attributes.avg_duration_ms as number | undefined) ??
    DEFAULT_CLOUD_RUN_DURATION_MS;

  const durationSeconds = avgDurationMs / 1000;
  const cpuSeconds = requestsPerMonth * durationSeconds * vcpus;
  const memGibSeconds = requestsPerMonth * durationSeconds * memoryGib;

  const cpuCost = cpuSeconds * CLOUD_RUN_VCPU_PER_SECOND;
  const memCost = memGibSeconds * CLOUD_RUN_MEMORY_GIB_PER_SECOND;
  const totalMonthly = cpuCost + memCost;

  breakdown.push({
    description: `Cloud Run vCPU time (${cpuSeconds.toFixed(0)} vCPU-seconds/month)`,
    unit: "vCPU-second",
    quantity: cpuSeconds,
    unit_price: CLOUD_RUN_VCPU_PER_SECOND,
    monthly_cost: cpuCost,
  });

  breakdown.push({
    description: `Cloud Run memory time (${memGibSeconds.toFixed(0)} GiB-seconds/month)`,
    unit: "GiB-second",
    quantity: memGibSeconds,
    unit_price: CLOUD_RUN_MEMORY_GIB_PER_SECOND,
    monthly_cost: memCost,
  });

  if (!resource.attributes.monthly_requests) {
    notes.push(
      `Default assumption: ${DEFAULT_CLOUD_RUN_REQUESTS.toLocaleString()} requests/month, ` +
      `${DEFAULT_CLOUD_RUN_DURATION_MS}ms avg duration`
    );
  }

  notes.push(`Cloud Run: ${vcpus} vCPU, ${memoryGib.toFixed(2)}GiB memory`);

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
// Google BigQuery pricing
// ---------------------------------------------------------------------------

const BIGQUERY_QUERY_PER_TB = 5.0;
const BIGQUERY_STORAGE_PER_GB = 0.02;
const DEFAULT_BIGQUERY_QUERY_TB = 1;
const DEFAULT_BIGQUERY_STORAGE_GB = 10;

/**
 * Calculates the monthly cost for a Google BigQuery dataset.
 *
 * On-demand queries: $5/TB
 * Storage: $0.02/GB/month
 */
export function calculateBigQueryCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const queryTbPerMonth =
    (resource.attributes.monthly_query_tb as number | undefined) ??
    DEFAULT_BIGQUERY_QUERY_TB;
  const storageGb =
    (resource.attributes.storage_size_gb as number | undefined) ??
    DEFAULT_BIGQUERY_STORAGE_GB;

  const queryCost = queryTbPerMonth * BIGQUERY_QUERY_PER_TB;
  const storageCost = storageGb * BIGQUERY_STORAGE_PER_GB;
  const totalMonthly = queryCost + storageCost;

  breakdown.push({
    description: `BigQuery on-demand queries (${queryTbPerMonth}TB/month)`,
    unit: "TB queried",
    quantity: queryTbPerMonth,
    unit_price: BIGQUERY_QUERY_PER_TB,
    monthly_cost: queryCost,
  });

  breakdown.push({
    description: `BigQuery storage (${storageGb}GB)`,
    unit: "GB-Mo",
    quantity: storageGb,
    unit_price: BIGQUERY_STORAGE_PER_GB,
    monthly_cost: storageCost,
  });

  if (!resource.attributes.monthly_query_tb) {
    notes.push(
      `Default assumption: ${DEFAULT_BIGQUERY_QUERY_TB}TB queries/month — ` +
      "provide monthly_query_tb attribute for accuracy"
    );
  }

  if (resource.attributes.location) {
    notes.push(`BigQuery location: ${resource.attributes.location}`);
  }

  notes.push("BigQuery on-demand pricing; flat-rate/reservations not included");

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
// Google Cloud Functions pricing
// ---------------------------------------------------------------------------

const GCF_PER_MILLION_INVOCATIONS = 0.40;
const GCF_GB_SECOND_PRICE = 0.0000025;
const DEFAULT_GCF_INVOCATIONS = 1_000_000;
const DEFAULT_GCF_DURATION_MS = 200;
const DEFAULT_GCF_MEMORY_MB = 256;

/**
 * Calculates the monthly cost for a Google Cloud Function.
 *
 * Cost = $0.40/million invocations + $0.0000025/GB-second
 */
export function calculateGcpFunctionCost(
  resource: ParsedResource,
  targetProvider: CloudProvider,
  targetRegion: string
): CostEstimate {
  const notes: string[] = [];
  const breakdown: CostLineItem[] = [];

  const invocations =
    (resource.attributes.monthly_invocations as number | undefined) ??
    DEFAULT_GCF_INVOCATIONS;
  const durationMs =
    (resource.attributes.avg_duration_ms as number | undefined) ??
    DEFAULT_GCF_DURATION_MS;
  const memoryMb =
    (resource.attributes.memory_size as number | undefined) ??
    DEFAULT_GCF_MEMORY_MB;

  const invocationCost = (invocations / 1_000_000) * GCF_PER_MILLION_INVOCATIONS;
  const gbSeconds = invocations * (durationMs / 1000) * (memoryMb / 1024);
  const computeCost = gbSeconds * GCF_GB_SECOND_PRICE;
  const totalMonthly = invocationCost + computeCost;

  breakdown.push({
    description: `Cloud Functions invocations (${(invocations / 1_000_000).toFixed(1)}M/month)`,
    unit: "1M invocations",
    quantity: invocations / 1_000_000,
    unit_price: GCF_PER_MILLION_INVOCATIONS,
    monthly_cost: invocationCost,
  });

  breakdown.push({
    description: `Cloud Functions compute (${gbSeconds.toFixed(0)} GB-seconds/month)`,
    unit: "GB-second",
    quantity: gbSeconds,
    unit_price: GCF_GB_SECOND_PRICE,
    monthly_cost: computeCost,
  });

  if (!resource.attributes.monthly_invocations) {
    notes.push(
      `Default assumption: ${DEFAULT_GCF_INVOCATIONS.toLocaleString()} invocations/month, ` +
      `${DEFAULT_GCF_DURATION_MS}ms avg, ${DEFAULT_GCF_MEMORY_MB}MB memory`
    );
  }

  if (resource.attributes.runtime) {
    notes.push(`Cloud Function runtime: ${resource.attributes.runtime}`);
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
    confidence: "medium",
    notes,
    pricing_source: "fallback",
  };
}
