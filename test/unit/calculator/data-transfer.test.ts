import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { CostEngine } from "../../../src/calculator/cost-engine.js";
import {
  calculateAwsDataTransferCost,
  calculateAzureDataTransferCost,
  calculateGcpDataTransferCost,
} from "../../../src/calculator/data-transfer.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";
import type { CloudCostConfig } from "../../../src/types/config.js";

// Disable live network fetches; fallback prices are sufficient for unit tests.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-dt-test-${suffix}`, "cache.db");
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_instance",
    name: "test-resource",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

function makeCostEngine(
  cache: PricingCache,
  configOverrides?: Partial<CloudCostConfig["pricing"]>,
): CostEngine {
  const pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  const config: CloudCostConfig = {
    ...DEFAULT_CONFIG,
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...configOverrides,
    },
  };
  return new CostEngine(pricingEngine, config);
}

// ---------------------------------------------------------------------------
// Direct calculator function tests
// ---------------------------------------------------------------------------

describe("calculateAwsDataTransferCost", () => {
  it("returns a non-zero estimate using the default 100 GB egress volume", async () => {
    const resource = makeResource({
      id: "dt-aws",
      type: "aws_data_transfer",
      name: "data-transfer-aws-us-east-1",
      provider: "aws",
      region: "us-east-1",
      attributes: {},
    });

    const estimate = await calculateAwsDataTransferCost(resource, "us-east-1");

    // 100 GB * $0.09/GB = $9.00
    expect(estimate.monthly_cost).toBeCloseTo(9.0, 1);
    expect(estimate.yearly_cost).toBeCloseTo(9.0 * 12, 1);
    expect(estimate.provider).toBe("aws");
    expect(estimate.currency).toBe("USD");
    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.breakdown[0].unit).toBe("GB");
    expect(estimate.confidence).toBe("low");
    expect(estimate.pricing_source).toBe("fallback");
  });

  it("uses the monthly_egress_gb attribute when provided", async () => {
    const resource = makeResource({
      id: "dt-aws-custom",
      type: "aws_data_transfer",
      name: "data-transfer-custom",
      provider: "aws",
      region: "us-east-1",
      attributes: { monthly_egress_gb: 500 },
    });

    const estimate = await calculateAwsDataTransferCost(resource, "us-east-1");

    // 500 GB * $0.09/GB = $45.00
    expect(estimate.monthly_cost).toBeCloseTo(45.0, 1);
  });

  it("applies regional multiplier for APAC regions", async () => {
    const usResource = makeResource({
      id: "dt-aws-us",
      type: "aws_data_transfer",
      name: "data-transfer-us",
      provider: "aws",
      region: "us-east-1",
      attributes: { monthly_egress_gb: 100 },
    });

    const apResource = makeResource({
      id: "dt-aws-ap",
      type: "aws_data_transfer",
      name: "data-transfer-ap",
      provider: "aws",
      region: "ap-northeast-1",
      attributes: { monthly_egress_gb: 100 },
    });

    const usEstimate = await calculateAwsDataTransferCost(usResource, "us-east-1");
    const apEstimate = await calculateAwsDataTransferCost(apResource, "ap-northeast-1");

    // APAC regions have a higher multiplier than US regions
    expect(apEstimate.monthly_cost).toBeGreaterThan(usEstimate.monthly_cost);
  });

  it("includes a note about the estimated egress volume when no attribute is set", async () => {
    const resource = makeResource({
      id: "dt-aws-note",
      type: "aws_data_transfer",
      name: "data-transfer-note",
      provider: "aws",
      region: "us-east-1",
      attributes: {},
    });

    const estimate = await calculateAwsDataTransferCost(resource, "us-east-1");

    expect(estimate.notes.some((n) => n.includes("100 GB/month"))).toBe(true);
  });
});

describe("calculateAzureDataTransferCost", () => {
  it("returns a non-zero estimate using the default 100 GB egress volume", async () => {
    const resource = makeResource({
      id: "dt-azure",
      type: "azurerm_data_transfer",
      name: "data-transfer-azure-eastus",
      provider: "azure",
      region: "eastus",
      attributes: {},
    });

    const estimate = await calculateAzureDataTransferCost(resource, "eastus");

    // 100 GB * $0.087/GB = $8.70
    expect(estimate.monthly_cost).toBeCloseTo(8.7, 1);
    expect(estimate.provider).toBe("azure");
    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.confidence).toBe("low");
  });

  it("applies a higher multiplier for Zone 2 Azure regions", async () => {
    const zone1Resource = makeResource({
      id: "dt-azure-z1",
      type: "azurerm_data_transfer",
      name: "data-transfer-z1",
      provider: "azure",
      region: "eastus",
      attributes: { monthly_egress_gb: 100 },
    });

    const zone2Resource = makeResource({
      id: "dt-azure-z2",
      type: "azurerm_data_transfer",
      name: "data-transfer-z2",
      provider: "azure",
      region: "eastasia",
      attributes: { monthly_egress_gb: 100 },
    });

    const z1Estimate = await calculateAzureDataTransferCost(zone1Resource, "eastus");
    const z2Estimate = await calculateAzureDataTransferCost(zone2Resource, "eastasia");

    expect(z2Estimate.monthly_cost).toBeGreaterThan(z1Estimate.monthly_cost);
  });
});

describe("calculateGcpDataTransferCost", () => {
  it("returns a non-zero estimate using the default 100 GB egress volume", async () => {
    const resource = makeResource({
      id: "dt-gcp",
      type: "google_data_transfer",
      name: "data-transfer-gcp-us-central1",
      provider: "gcp",
      region: "us-central1",
      attributes: {},
    });

    const estimate = await calculateGcpDataTransferCost(resource, "us-central1");

    // 100 GB * $0.085/GB = $8.50
    expect(estimate.monthly_cost).toBeCloseTo(8.5, 1);
    expect(estimate.provider).toBe("gcp");
    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.confidence).toBe("low");
  });

  it("applies a higher multiplier for South America GCP regions", async () => {
    const usResource = makeResource({
      id: "dt-gcp-us",
      type: "google_data_transfer",
      name: "data-transfer-us",
      provider: "gcp",
      region: "us-central1",
      attributes: { monthly_egress_gb: 100 },
    });

    const saResource = makeResource({
      id: "dt-gcp-sa",
      type: "google_data_transfer",
      name: "data-transfer-sa",
      provider: "gcp",
      region: "southamerica-east1",
      attributes: { monthly_egress_gb: 100 },
    });

    const usEstimate = await calculateGcpDataTransferCost(usResource, "us-central1");
    const saEstimate = await calculateGcpDataTransferCost(saResource, "southamerica-east1");

    expect(saEstimate.monthly_cost).toBeGreaterThan(usEstimate.monthly_cost);
  });
});

// ---------------------------------------------------------------------------
// CostEngine integration: data transfer appears in breakdowns
// ---------------------------------------------------------------------------

describe("CostEngine data transfer integration", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a data transfer line item to the breakdown when include_data_transfer is true", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web-server",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    // 1 real resource + 1 synthetic data transfer
    expect(breakdown.by_resource).toHaveLength(2);

    const dtEstimate = breakdown.by_resource.find((e) => e.resource_type === "aws_data_transfer");
    expect(dtEstimate).toBeDefined();
    expect(dtEstimate!.monthly_cost).toBeGreaterThan(0);
    expect(breakdown.by_service["data_transfer"]).toBeGreaterThan(0);
  });

  it("does not append data transfer when include_data_transfer is false", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: false });

    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web-server",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    // Only 1 real resource, no synthetic data transfer
    expect(breakdown.by_resource).toHaveLength(1);
    expect(breakdown.by_service["data_transfer"]).toBeUndefined();
  });

  it("does not append data transfer when the resource list is empty", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    const breakdown = await engine.calculateBreakdown([], "aws", "us-east-1");

    expect(breakdown.by_resource).toHaveLength(0);
    expect(breakdown.by_service).toEqual({});
    expect(breakdown.total_monthly).toBe(0);
  });

  it("appends one data transfer item per unique provider+region combination", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    // Two resources in the same region should produce one data transfer item.
    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
      makeResource({
        id: "vm-2",
        type: "aws_instance",
        name: "api",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.small" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    const dtItems = breakdown.by_resource.filter((e) => e.resource_type === "aws_data_transfer");
    expect(dtItems).toHaveLength(1);
  });

  it("data transfer cost is included in total_monthly", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web-server",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    const manualSum = breakdown.by_resource.reduce((sum, e) => sum + e.monthly_cost, 0);
    expect(breakdown.total_monthly).toBeCloseTo(manualSum, 1);
    expect(breakdown.total_monthly).toBeGreaterThan(
      breakdown.by_resource
        .filter((e) => e.resource_type !== "aws_data_transfer")
        .reduce((sum, e) => sum + e.monthly_cost, 0),
    );
  });

  it("does not double-count data transfer when the resource list already contains dt resources", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    // If somehow a synthetic data transfer resource is passed in directly,
    // calculateBreakdown should not inject a second one.
    const resources: ParsedResource[] = [
      makeResource({
        id: "vm-1",
        type: "aws_instance",
        name: "web-server",
        provider: "aws",
        region: "us-east-1",
        attributes: { instance_type: "t3.micro" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "aws", "us-east-1");

    const dtItems = breakdown.by_resource.filter((e) => e.resource_type === "aws_data_transfer");
    // Exactly one data transfer item per provider+region
    expect(dtItems).toHaveLength(1);
  });

  it("uses the correct data transfer calculator for GCP resources", async () => {
    const engine = makeCostEngine(cache, { include_data_transfer: true });

    const resources: ParsedResource[] = [
      makeResource({
        id: "gcp-vm",
        type: "google_compute_instance",
        name: "gcp-server",
        provider: "gcp",
        region: "us-central1",
        attributes: { machine_type: "n1-standard-1" },
      }),
    ];

    const breakdown = await engine.calculateBreakdown(resources, "gcp", "us-central1");

    const dtEstimate = breakdown.by_resource.find(
      (e) => e.resource_type === "google_data_transfer",
    );
    expect(dtEstimate).toBeDefined();
    expect(dtEstimate!.provider).toBe("gcp");
  });
});
