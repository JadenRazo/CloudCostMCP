import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerraform } from "../../../src/parsers/index.js";
import { detectProvider } from "../../../src/parsers/provider-detector.js";
import { resolveVariables, substituteVariables } from "../../../src/parsers/variable-resolver.js";
import { parseHclToJson } from "../../../src/parsers/hcl-parser.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(process.cwd(), "test/fixtures");

function readFixture(fixture: string, filename: string): string {
  return readFileSync(join(FIXTURES, fixture, filename), "utf-8");
}

function simpleEc2Files() {
  return [
    { path: "main.tf", content: readFixture("simple-ec2", "main.tf") },
    { path: "variables.tf", content: readFixture("simple-ec2", "variables.tf") },
  ];
}

function fullStackFiles() {
  return [
    { path: "main.tf", content: readFixture("full-stack", "main.tf") },
    { path: "variables.tf", content: readFixture("full-stack", "variables.tf") },
  ];
}

function fullStackTfvars() {
  return readFixture("full-stack", "terraform.tfvars");
}

// ---------------------------------------------------------------------------
// Provider detector
// ---------------------------------------------------------------------------

describe("detectProvider", () => {
  it("returns aws for aws_ prefixed resource types", () => {
    expect(detectProvider("aws_instance")).toBe("aws");
    expect(detectProvider("aws_db_instance")).toBe("aws");
    expect(detectProvider("aws_s3_bucket")).toBe("aws");
  });

  it("returns azure for azurerm_ prefixed resource types", () => {
    expect(detectProvider("azurerm_linux_virtual_machine")).toBe("azure");
    expect(detectProvider("azurerm_managed_disk")).toBe("azure");
  });

  it("returns gcp for google_ prefixed resource types", () => {
    expect(detectProvider("google_compute_instance")).toBe("gcp");
    expect(detectProvider("google_sql_database_instance")).toBe("gcp");
  });

  it("throws for unknown resource type prefixes", () => {
    expect(() => detectProvider("unknown_resource")).toThrow();
    expect(() => detectProvider("digitalocean_droplet")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Variable resolver
// ---------------------------------------------------------------------------

describe("resolveVariables", () => {
  it("extracts defaults from HCL JSON variable blocks", async () => {
    const hcl = readFixture("simple-ec2", "variables.tf");
    const json = await parseHclToJson(hcl, "variables.tf");
    const vars = resolveVariables(json);

    expect(vars["region"]).toBe("us-west-2");
    expect(vars["instance_type"]).toBe("t3.micro");
  });

  it("overrides defaults with tfvars values", async () => {
    const hcl = readFixture("full-stack", "variables.tf");
    const json = await parseHclToJson(hcl, "variables.tf");
    const vars = resolveVariables(json, fullStackTfvars());

    // tfvars overrides the variable default of "t3.large"
    expect(vars["instance_type"]).toBe("t3.xlarge");
    // tfvars overrides "us-east-1"
    expect(vars["region"]).toBe("us-west-2");
    // numeric override
    expect(vars["volume_size"]).toBe(100);
  });

  it("preserves defaults for variables not present in tfvars", async () => {
    const hcl = readFixture("full-stack", "variables.tf");
    const json = await parseHclToJson(hcl, "variables.tf");
    const vars = resolveVariables(json, fullStackTfvars());

    // ami_id has a default and is NOT in the tfvars file
    expect(vars["ami_id"]).toBe("ami-0c55b159cbfafe1f0");
  });

  it("returns empty object when no variable blocks exist", () => {
    const vars = resolveVariables({});
    expect(vars).toEqual({});
  });
});

describe("substituteVariables", () => {
  const vars = { region: "us-west-2", count: 3, enabled: true };

  it("replaces a whole-string var reference and preserves the original type", () => {
    expect(substituteVariables("${var.count}", vars)).toBe(3);
    expect(substituteVariables("${var.enabled}", vars)).toBe(true);
    expect(substituteVariables("${var.region}", vars)).toBe("us-west-2");
  });

  it("replaces inline var references within a larger string", () => {
    expect(substituteVariables("Region: ${var.region}", vars)).toBe(
      "Region: us-west-2"
    );
  });

  it("leaves unknown var references unchanged", () => {
    expect(substituteVariables("${var.unknown}", vars)).toBe("${var.unknown}");
  });

  it("recurses into arrays and objects", () => {
    const result = substituteVariables(
      { type: "${var.region}", nested: ["${var.count}"] },
      vars
    ) as Record<string, unknown>;

    expect(result["type"]).toBe("us-west-2");
    expect((result["nested"] as unknown[])[0]).toBe(3);
  });

  it("passes through non-string scalars unchanged", () => {
    expect(substituteVariables(42, vars)).toBe(42);
    expect(substituteVariables(false, vars)).toBe(false);
    expect(substituteVariables(null, vars)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HCL parser (raw)
// ---------------------------------------------------------------------------

describe("parseHclToJson", () => {
  it("parses a valid HCL file and returns a plain object", async () => {
    const hcl = readFixture("simple-ec2", "main.tf");
    const json = await parseHclToJson(hcl, "main.tf");

    expect(typeof json).toBe("object");
    expect(json).not.toBeNull();
    expect(json["resource"]).toBeDefined();
    expect(json["provider"]).toBeDefined();
  });

  it("returns an empty object for blank input", async () => {
    const json = await parseHclToJson("", "empty.tf");
    expect(json).toEqual({});
  });

  it("throws a descriptive error for invalid HCL", async () => {
    await expect(
      parseHclToJson("resource {{{ invalid hcl !!!", "bad.tf")
    ).rejects.toThrow(/bad\.tf/);
  });
});

// ---------------------------------------------------------------------------
// Simple EC2 fixture – parseTerraform integration
// ---------------------------------------------------------------------------

describe("parseTerraform – simple-ec2 fixture", () => {
  it("extracts exactly 2 aws_instance resources", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    const instances = inventory.resources.filter(
      (r) => r.type === "aws_instance"
    );
    expect(instances).toHaveLength(2);
  });

  it("sets the correct instance_type for the web server", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.attributes.instance_type).toBe("t3.micro");
  });

  it("sets the correct instance_type for the api server", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    const api = inventory.resources.find((r) => r.name === "api");
    expect(api?.attributes.instance_type).toBe("t3.small");
  });

  it("detects provider as aws for all resources", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    for (const resource of inventory.resources) {
      expect(resource.provider).toBe("aws");
    }
  });

  it("detects region from the provider block (us-west-2)", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    expect(inventory.region).toBe("us-west-2");
    for (const resource of inventory.resources) {
      expect(resource.region).toBe("us-west-2");
    }
  });

  it("extracts tags correctly for the web server", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.tags["Name"]).toBe("web-server");
    expect(web?.tags["Environment"]).toBe("production");
  });

  it("extracts root_block_device storage attributes for the web server", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.attributes.storage_size_gb).toBe(20);
    expect(web?.attributes.storage_type).toBe("gp3");
  });

  it("populates total_count and by_type correctly", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    expect(inventory.total_count).toBe(2);
    expect(inventory.by_type["aws_instance"]).toBe(2);
  });

  it("sets the inventory provider to aws", async () => {
    const inventory = await parseTerraform(simpleEc2Files());
    expect(inventory.provider).toBe("aws");
  });
});

// ---------------------------------------------------------------------------
// Full-stack fixture – parseTerraform integration
// ---------------------------------------------------------------------------

describe("parseTerraform – full-stack fixture", () => {
  it("extracts all expected resource types", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const types = new Set(inventory.resources.map((r) => r.type));

    expect(types.has("aws_instance")).toBe(true);
    expect(types.has("aws_db_instance")).toBe(true);
    expect(types.has("aws_s3_bucket")).toBe(true);
    expect(types.has("aws_lb")).toBe(true);
    expect(types.has("aws_nat_gateway")).toBe(true);
  });

  it("resolves instance_type from tfvars override (t3.xlarge)", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const app = inventory.resources.find(
      (r) => r.type === "aws_instance" && r.name === "app"
    );
    expect(app?.attributes.instance_type).toBe("t3.xlarge");
  });

  it("resolves volume_size from tfvars override (100)", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const app = inventory.resources.find(
      (r) => r.type === "aws_instance" && r.name === "app"
    );
    expect(app?.attributes.storage_size_gb).toBe(100);
  });

  it("uses variable default when tfvars does not override (ami_id)", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const app = inventory.resources.find(
      (r) => r.type === "aws_instance" && r.name === "app"
    );
    expect(app?.attributes.ami).toBe("ami-0c55b159cbfafe1f0");
  });

  it("detects region as us-west-2 from tfvars-resolved provider block", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    expect(inventory.region).toBe("us-west-2");
  });

  it("extracts database engine correctly", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const db = inventory.resources.find((r) => r.type === "aws_db_instance");
    expect(db?.attributes.engine).toBe("postgres");
  });

  it("extracts multi_az flag as boolean true", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const db = inventory.resources.find((r) => r.type === "aws_db_instance");
    expect(db?.attributes.multi_az).toBe(true);
  });

  it("extracts allocated_storage for the database", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const db = inventory.resources.find((r) => r.type === "aws_db_instance");
    expect(db?.attributes.storage_size_gb).toBe(100);
  });

  it("extracts database tags", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const db = inventory.resources.find((r) => r.type === "aws_db_instance");
    expect(db?.tags["Name"]).toBe("main-database");
  });

  it("extracts load_balancer_type for the LB resource", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    const lb = inventory.resources.find((r) => r.type === "aws_lb");
    expect(lb?.attributes.load_balancer_type).toBe("application");
  });

  it("records 5 total resources across all types", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    expect(inventory.total_count).toBe(5);
  });

  it("has no parse warnings for valid fixtures", async () => {
    const inventory = await parseTerraform(fullStackFiles(), fullStackTfvars());
    expect(inventory.parse_warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseTerraform – edge cases", () => {
  it("returns an empty inventory for an empty file list", async () => {
    const inventory = await parseTerraform([]);
    expect(inventory.total_count).toBe(0);
    expect(inventory.resources).toHaveLength(0);
  });

  it("records a warning and continues when one file has a parse error", async () => {
    const files = [
      { path: "bad.tf", content: "resource {{{ not valid hcl !!!" },
      { path: "main.tf", content: readFixture("simple-ec2", "main.tf") },
    ];

    const inventory = await parseTerraform(files);
    expect(inventory.parse_warnings.length).toBeGreaterThan(0);
    // The valid file's resources should still be extracted
    expect(inventory.total_count).toBeGreaterThan(0);
  });

  it("falls back to us-east-1 when no provider block is present", async () => {
    const hcl = `
resource "aws_instance" "solo" {
  ami           = "ami-abc123"
  instance_type = "t3.nano"
}
`;
    const inventory = await parseTerraform([
      { path: "main.tf", content: hcl },
    ]);
    expect(inventory.region).toBe("us-east-1");
  });

  it("silently skips data source blocks without counting them as resources", async () => {
    const hcl = `
resource "aws_instance" "web" {
  ami           = "ami-abc123"
  instance_type = "t3.micro"
}

data "aws_ami" "latest" {
  most_recent = true

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*"]
  }
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    // Only the resource should be counted, not the data source
    expect(inventory.total_count).toBe(1);
    expect(inventory.resources.every((r) => r.type !== "aws_ami")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// count / for_each fixture
// ---------------------------------------------------------------------------

function countForeachFiles() {
  return [
    { path: "main.tf", content: readFixture("count-foreach", "main.tf") },
  ];
}

describe("parseTerraform – count attribute", () => {
  it("expands count=3 into 3 separate resources", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const instances = inventory.resources.filter(
      (r) => r.type === "aws_instance"
    );
    expect(instances).toHaveLength(3);
  });

  it("gives each expanded instance a unique indexed id", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const instances = inventory.resources.filter(
      (r) => r.type === "aws_instance"
    );
    const ids = instances.map((r) => r.id);
    expect(ids).toContain("aws_instance.web[0]");
    expect(ids).toContain("aws_instance.web[1]");
    expect(ids).toContain("aws_instance.web[2]");
  });

  it("all expanded instances share the same instance_type", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const instances = inventory.resources.filter(
      (r) => r.type === "aws_instance"
    );
    for (const inst of instances) {
      expect(inst.attributes.instance_type).toBe("t3.micro");
    }
  });

  it("count produces a warning when the value cannot be resolved", async () => {
    const hcl = `
resource "aws_instance" "web" {
  count         = var.instance_count
  ami           = "ami-abc123"
  instance_type = "t3.micro"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    // Defaults to 1 when unresolvable
    expect(inventory.resources.filter((r) => r.type === "aws_instance")).toHaveLength(1);
    const countWarning = inventory.parse_warnings.find((w) =>
      w.includes("count") && w.includes("aws_instance.web")
    );
    expect(countWarning).toBeDefined();
  });
});

describe("parseTerraform – for_each attribute", () => {
  it("creates one resource when for_each cannot be statically resolved", async () => {
    // toset([...]) is an HCL function that the static parser cannot evaluate,
    // so the for_each falls back to 1 instance with a warning
    const inventory = await parseTerraform(countForeachFiles());
    const queues = inventory.resources.filter(
      (r) => r.type === "aws_sqs_queue"
    );
    expect(queues).toHaveLength(1);
  });

  it("emits a for_each warning when the expression cannot be resolved", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const warning = inventory.parse_warnings.find((w) =>
      w.includes("for_each") && w.includes("aws_sqs_queue.queues")
    );
    expect(warning).toBeDefined();
  });

  it("expands a literal object for_each into one resource per key", async () => {
    const hcl = `
resource "aws_sqs_queue" "named" {
  for_each = {
    orders        = "high"
    notifications = "low"
  }
  name = each.key
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const queues = inventory.resources.filter(
      (r) => r.type === "aws_sqs_queue"
    );
    expect(queues).toHaveLength(2);
    const ids = queues.map((r) => r.id);
    expect(ids).toContain('aws_sqs_queue.named["orders"]');
    expect(ids).toContain('aws_sqs_queue.named["notifications"]');
  });
});

// ---------------------------------------------------------------------------
// Module detection
// ---------------------------------------------------------------------------

describe("parseTerraform – module blocks", () => {
  it("generates a warning for each registry module that has not been initialised", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const moduleWarning = inventory.parse_warnings.find((w) =>
      w.includes('"vpc"') && w.includes(".terraform/modules")
    );
    expect(moduleWarning).toBeDefined();
  });

  it("does not add module entries to the resource list", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const moduleResources = inventory.resources.filter(
      (r) => r.type === "module" || r.name === "vpc"
    );
    expect(moduleResources).toHaveLength(0);
  });

  it("emits one warning per uninitialised registry module block", async () => {
    const hcl = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

module "eks" {
  source = "terraform-aws-modules/eks/aws"
}
`;
    // basePath is not provided, so module resolver uses dirname of the first
    // file path ("main.tf") which gives "." — .terraform/modules will not exist
    // there, so both registry modules should emit "not found" warnings.
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const moduleWarnings = inventory.parse_warnings.filter((w) =>
      w.includes(".terraform/modules")
    );
    expect(moduleWarnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// New resource type extractors
// ---------------------------------------------------------------------------

describe("parseTerraform – aws_lambda_function extractor", () => {
  it("extracts memory_size, timeout, and runtime from the fixture", async () => {
    const inventory = await parseTerraform(countForeachFiles());
    const lambda = inventory.resources.find(
      (r) => r.type === "aws_lambda_function"
    );
    expect(lambda).toBeDefined();
    expect(lambda?.attributes.memory_size).toBe(256);
    expect(lambda?.attributes.timeout).toBe(30);
    expect(lambda?.attributes.runtime).toBe("nodejs20.x");
  });
});

describe("parseTerraform – aws_dynamodb_table extractor", () => {
  it("extracts billing_mode, read_capacity, and write_capacity", async () => {
    const hcl = `
resource "aws_dynamodb_table" "orders" {
  name         = "orders"
  billing_mode = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const table = inventory.resources.find(
      (r) => r.type === "aws_dynamodb_table"
    );
    expect(table?.attributes.billing_mode).toBe("PROVISIONED");
    expect(table?.attributes.read_capacity).toBe(5);
    expect(table?.attributes.write_capacity).toBe(5);
  });
});

describe("parseTerraform – aws_elasticache_replication_group extractor", () => {
  it("extracts node_type and num_cache_clusters", async () => {
    const hcl = `
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "my-redis"
  node_type            = "cache.r6g.large"
  num_cache_clusters   = 2
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const rg = inventory.resources.find(
      (r) => r.type === "aws_elasticache_replication_group"
    );
    expect(rg?.attributes.instance_type).toBe("cache.r6g.large");
    expect(rg?.attributes.node_count).toBe(2);
  });
});

describe("parseTerraform – aws_efs_file_system extractor", () => {
  it("extracts performance_mode and throughput_mode", async () => {
    const hcl = `
resource "aws_efs_file_system" "shared" {
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const efs = inventory.resources.find(
      (r) => r.type === "aws_efs_file_system"
    );
    expect(efs?.attributes.performance_mode).toBe("generalPurpose");
    expect(efs?.attributes.throughput_mode).toBe("bursting");
  });
});

describe("parseTerraform – aws_cloudfront_distribution extractor", () => {
  it("extracts price_class", async () => {
    const hcl = `
resource "aws_cloudfront_distribution" "cdn" {
  price_class = "PriceClass_100"
  enabled     = true
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const cdn = inventory.resources.find(
      (r) => r.type === "aws_cloudfront_distribution"
    );
    expect(cdn?.attributes.price_class).toBe("PriceClass_100");
  });
});

describe("parseTerraform – aws_sqs_queue extractor", () => {
  it("extracts fifo_queue attribute", async () => {
    const hcl = `
resource "aws_sqs_queue" "fifo" {
  name       = "my-queue.fifo"
  fifo_queue = true
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const q = inventory.resources.find((r) => r.type === "aws_sqs_queue");
    expect(q?.attributes.fifo_queue).toBe(true);
  });
});

describe("parseTerraform – aws_rds_cluster extractor (extended)", () => {
  it("extracts engine, engine_version, and db_cluster_instance_class", async () => {
    const hcl = `
resource "aws_rds_cluster" "aurora" {
  engine                     = "aurora-postgresql"
  engine_version             = "15.4"
  db_cluster_instance_class  = "db.r6g.large"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const cluster = inventory.resources.find(
      (r) => r.type === "aws_rds_cluster"
    );
    expect(cluster?.attributes.engine).toBe("aurora-postgresql");
    expect(cluster?.attributes.engine_version).toBe("15.4");
    expect(cluster?.attributes.instance_type).toBe("db.r6g.large");
  });
});

describe("parseTerraform – azurerm_cosmosdb_account extractor", () => {
  it("extracts offer_type and kind", async () => {
    const hcl = `
resource "azurerm_cosmosdb_account" "db" {
  name       = "my-cosmos"
  offer_type = "Standard"
  kind       = "GlobalDocumentDB"
  location   = "eastus"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const cosmos = inventory.resources.find(
      (r) => r.type === "azurerm_cosmosdb_account"
    );
    expect(cosmos?.attributes.offer_type).toBe("Standard");
    expect(cosmos?.attributes.kind).toBe("GlobalDocumentDB");
  });
});

describe("parseTerraform – azurerm_storage_account extractor", () => {
  it("extracts account_tier and account_replication_type", async () => {
    const hcl = `
resource "azurerm_storage_account" "store" {
  name                     = "mystore"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  location                 = "eastus"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const sa = inventory.resources.find(
      (r) => r.type === "azurerm_storage_account"
    );
    expect(sa?.attributes.account_tier).toBe("Standard");
    expect(sa?.attributes.account_replication_type).toBe("LRS");
  });
});

describe("parseTerraform – azurerm_redis_cache extractor", () => {
  it("extracts capacity, family, and sku_name", async () => {
    const hcl = `
resource "azurerm_redis_cache" "cache" {
  name     = "my-redis"
  capacity = 2
  family   = "C"
  sku_name = "Standard"
  location = "eastus"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const cache = inventory.resources.find(
      (r) => r.type === "azurerm_redis_cache"
    );
    expect(cache?.attributes.capacity).toBe(2);
    expect(cache?.attributes.family).toBe("C");
    expect(cache?.attributes.sku).toBe("Standard");
  });
});

describe("parseTerraform – google_cloudfunctions_function extractor", () => {
  it("extracts runtime and available_memory_mb", async () => {
    const hcl = `
resource "google_cloudfunctions_function" "fn" {
  name                  = "my-function"
  runtime               = "nodejs20"
  available_memory_mb   = 512
  trigger_http          = true
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const fn = inventory.resources.find(
      (r) => r.type === "google_cloudfunctions_function"
    );
    expect(fn?.attributes.runtime).toBe("nodejs20");
    expect(fn?.attributes.memory_size).toBe(512);
  });
});

describe("parseTerraform – google_bigquery_dataset extractor", () => {
  it("extracts location", async () => {
    const hcl = `
resource "google_bigquery_dataset" "dataset" {
  dataset_id = "my_dataset"
  location   = "US"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const ds = inventory.resources.find(
      (r) => r.type === "google_bigquery_dataset"
    );
    expect(ds?.attributes.location).toBe("US");
  });
});

describe("parseTerraform – google_redis_instance extractor", () => {
  it("extracts tier and memory_size_gb", async () => {
    const hcl = `
resource "google_redis_instance" "cache" {
  name           = "my-cache"
  tier           = "STANDARD_HA"
  memory_size_gb = 4
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const redis = inventory.resources.find(
      (r) => r.type === "google_redis_instance"
    );
    expect(redis?.attributes.tier).toBe("STANDARD_HA");
    expect(redis?.attributes.memory_size).toBe(4);
  });
});

describe("parseTerraform – google_artifact_registry_repository extractor", () => {
  it("extracts format", async () => {
    const hcl = `
resource "google_artifact_registry_repository" "repo" {
  repository_id = "my-repo"
  format        = "DOCKER"
  location      = "us-central1"
}
`;
    const inventory = await parseTerraform([{ path: "main.tf", content: hcl }]);
    const repo = inventory.resources.find(
      (r) => r.type === "google_artifact_registry_repository"
    );
    expect(repo?.attributes.format).toBe("DOCKER");
  });
});
