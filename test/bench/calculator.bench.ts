import { bench, describe, beforeAll, afterAll } from "vitest";
import { calculateComputeCost } from "../../src/calculator/compute.js";
import { calculateDatabaseCost } from "../../src/calculator/database.js";
import { calculateStorageCost } from "../../src/calculator/storage.js";
import { CostEngine } from "../../src/calculator/cost-engine.js";
import { PricingEngine } from "../../src/pricing/pricing-engine.js";
import { PricingCache } from "../../src/pricing/cache.js";
import type { ParsedResource } from "../../src/types/resources.js";
import type { CloudCostConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Shared setup: PricingEngine backed by an empty cache (forces fallback pricing)
// ---------------------------------------------------------------------------

let cache: PricingCache;
let pricingEngine: PricingEngine;
let costEngine: CostEngine;
let tmpDir: string;

const config: CloudCostConfig = {
  ...DEFAULT_CONFIG,
  pricing: {
    ...DEFAULT_CONFIG.pricing,
    include_data_transfer: false,
  },
};

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bench-calc-"));
  cache = new PricingCache(join(tmpDir, "bench.db"));
  pricingEngine = new PricingEngine(cache, config);
  costEngine = new CostEngine(pricingEngine, config);
});

afterAll(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture resources
// ---------------------------------------------------------------------------

const computeResource: ParsedResource = {
  id: "aws_instance.web",
  type: "aws_instance",
  name: "web",
  provider: "aws",
  region: "us-east-1",
  attributes: {
    instance_type: "t3.large",
    ami: "ami-12345",
  },
  tags: { Name: "web" },
  source_file: "main.tf",
};

const databaseResource: ParsedResource = {
  id: "aws_db_instance.main",
  type: "aws_db_instance",
  name: "main",
  provider: "aws",
  region: "us-east-1",
  attributes: {
    instance_class: "db.r5.large",
    engine: "postgres",
    allocated_storage: 100,
  },
  tags: {},
  source_file: "main.tf",
};

const storageResource: ParsedResource = {
  id: "aws_ebs_volume.data",
  type: "aws_ebs_volume",
  name: "data",
  provider: "aws",
  region: "us-east-1",
  attributes: {
    storage_type: "gp3",
    storage_size_gb: 500,
  },
  tags: {},
  source_file: "main.tf",
};

const inventoryResources: ParsedResource[] = [
  computeResource,
  {
    ...computeResource,
    id: "aws_instance.api",
    name: "api",
    attributes: { instance_type: "t3.medium" },
  },
  {
    ...computeResource,
    id: "aws_instance.worker",
    name: "worker",
    attributes: { instance_type: "m5.xlarge" },
  },
  databaseResource,
  {
    ...databaseResource,
    id: "aws_db_instance.replica",
    name: "replica",
    attributes: { instance_class: "db.r5.large", engine: "mysql", allocated_storage: 50 },
  },
  storageResource,
  {
    ...storageResource,
    id: "aws_ebs_volume.logs",
    name: "logs",
    attributes: { storage_type: "gp3", storage_size_gb: 200 },
  },
  {
    id: "aws_s3_bucket.assets",
    type: "aws_s3_bucket",
    name: "assets",
    provider: "aws",
    region: "us-east-1",
    attributes: { storage_class: "STANDARD" },
    tags: {},
    source_file: "main.tf",
  },
  {
    id: "aws_nat_gateway.main",
    type: "aws_nat_gateway",
    name: "main",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
  },
  {
    id: "aws_lb.public",
    type: "aws_lb",
    name: "public",
    provider: "aws",
    region: "us-east-1",
    attributes: { type: "application" },
    tags: {},
    source_file: "main.tf",
  },
];

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Individual cost calculations", () => {
  bench("calculateComputeCost - single instance", async () => {
    await calculateComputeCost(computeResource, "aws", "us-east-1", pricingEngine);
  });

  bench("calculateDatabaseCost - single DB", async () => {
    await calculateDatabaseCost(databaseResource, "aws", "us-east-1", pricingEngine);
  });

  bench("calculateStorageCost - single volume", async () => {
    await calculateStorageCost(storageResource, "aws", "us-east-1", pricingEngine);
  });
});

describe("CostEngine full breakdown", () => {
  bench("CostEngine.calculateBreakdown - 10 resources", async () => {
    await costEngine.calculateBreakdown(inventoryResources, "aws", "us-east-1");
  });
});
