import { describe, it, expect } from "vitest";
import { mapPulumiResource } from "../../../src/parsers/pulumi/pulumi-resource-mapper.js";
import type { PulumiResource } from "../../../src/parsers/pulumi/pulumi-types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<PulumiResource>): PulumiResource {
  return {
    urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::web",
    type: "aws:ec2/instance:Instance",
    id: "i-default",
    inputs: {},
    outputs: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unsupported type
// ---------------------------------------------------------------------------

describe("mapPulumiResource — unsupported types", () => {
  it("returns null and pushes a warning for an unknown type", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({ type: "aws:unknown/unknown:Unknown" }),
      warnings,
    );
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unsupported Pulumi resource type");
  });

  it("returns null for the Pulumi Stack meta-resource", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({ type: "pulumi:pulumi:Stack", urn: "urn::::pulumi:pulumi:Stack::stack" }),
      warnings,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AWS attribute extraction
// ---------------------------------------------------------------------------

describe("mapPulumiResource — AWS attributes", () => {
  it("maps aws_instance attributes", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::web",
        type: "aws:ec2/instance:Instance",
        id: "i-123",
        inputs: { instanceType: "t3.large", ami: "ami-xxxx", tags: { Env: "prod" } },
        outputs: { availabilityZone: "us-east-1a" },
      }),
      warnings,
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe("aws_instance");
    expect(result!.provider).toBe("aws");
    expect(result!.region).toBe("us-east-1");
    expect(result!.attributes.instance_type).toBe("t3.large");
    expect(result!.attributes.ami).toBe("ami-xxxx");
    expect(result!.tags.Env).toBe("prod");
  });

  it("maps aws_db_instance attributes (class + engine + size + multi-az)", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "urn:pulumi:prod::project::aws:rds/instance:Instance::db",
        type: "aws:rds/instance:Instance",
        inputs: {
          instanceClass: "db.t3.medium",
          engine: "postgres",
          allocatedStorage: 100,
          multiAz: true,
        },
      }),
      warnings,
    );

    expect(result!.type).toBe("aws_db_instance");
    expect(result!.attributes.instance_type).toBe("db.t3.medium");
    expect(result!.attributes.engine).toBe("postgres");
    expect(result!.attributes.storage_size_gb).toBe(100);
    expect(result!.attributes.multi_az).toBe(true);
  });

  it("maps aws_ebs_volume attributes", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "urn:pulumi:prod::project::aws:ebs/volume:Volume::disk",
        type: "aws:ebs/volume:Volume",
        inputs: { type: "gp3", size: 100, iops: 3000 },
      }),
      warnings,
    );

    expect(result!.type).toBe("aws_ebs_volume");
    expect(result!.attributes.storage_type).toBe("gp3");
    expect(result!.attributes.storage_size_gb).toBe(100);
    expect(result!.attributes.iops).toBe(3000);
  });

  it("defaults lb_type to 'application' when not provided", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "urn:pulumi:prod::project::aws:lb/loadBalancer:LoadBalancer::alb",
        type: "aws:lb/loadBalancer:LoadBalancer",
        inputs: {},
      }),
      warnings,
    );

    expect(result!.type).toBe("aws_lb");
    expect(result!.attributes.lb_type).toBe("application");
  });

  it("uses the provided lb_type when supplied", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:lb/loadBalancer:LoadBalancer",
        urn: "urn:pulumi:prod::project::aws:lb/loadBalancer:LoadBalancer::nlb",
        inputs: { loadBalancerType: "network" },
      }),
      warnings,
    );

    expect(result!.attributes.lb_type).toBe("network");
  });

  it("maps aws_lambda_function memory + timeout from numeric inputs", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:lambda/function:Function",
        urn: "urn:pulumi:prod::project::aws:lambda/function:Function::fn",
        inputs: { memorySize: 512, timeout: 60 },
      }),
      warnings,
    );

    expect(result!.attributes.memory_size).toBe(512);
    expect(result!.attributes.timeout).toBe(60);
  });

  it("maps aws_dynamodb_table with PROVISIONED default and capacities", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:dynamodb/table:Table",
        urn: "urn:pulumi:prod::project::aws:dynamodb/table:Table::tbl",
        inputs: { readCapacity: 10, writeCapacity: 5 },
      }),
      warnings,
    );

    expect(result!.attributes.billing_mode).toBe("PROVISIONED");
    expect(result!.attributes.read_capacity).toBe(10);
    expect(result!.attributes.write_capacity).toBe(5);
  });

  it("honours an explicit billing_mode of PAY_PER_REQUEST", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:dynamodb/table:Table",
        urn: "urn:pulumi:prod::project::aws:dynamodb/table:Table::tbl",
        inputs: { billingMode: "PAY_PER_REQUEST" },
      }),
      warnings,
    );
    expect(result!.attributes.billing_mode).toBe("PAY_PER_REQUEST");
  });

  it("maps simple AWS types with empty attributes", () => {
    const warnings: string[] = [];
    const types = [
      ["aws:s3/bucket:Bucket", "aws_s3_bucket"],
      ["aws:ec2/natGateway:NatGateway", "aws_nat_gateway"],
      ["aws:eks/cluster:Cluster", "aws_eks_cluster"],
      ["aws:route53/zone:Zone", "aws_route53_zone"],
      ["aws:ecr/repository:Repository", "aws_ecr_repository"],
      ["aws:secretsmanager/secret:Secret", "aws_secretsmanager_secret"],
    ] as const;
    for (const [pulumi, internal] of types) {
      const result = mapPulumiResource(
        makeResource({ type: pulumi, urn: `urn:pulumi:prod::project::${pulumi}::x` }),
        warnings,
      );
      expect(result!.type).toBe(internal);
      expect(result!.attributes).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Azure attribute extraction
// ---------------------------------------------------------------------------

describe("mapPulumiResource — Azure attributes", () => {
  it("maps azure VM vm_size from vmSize input", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "azure:compute:VirtualMachine",
        urn: "urn:pulumi:prod::project::azure:compute:VirtualMachine::vm",
        inputs: { vmSize: "Standard_D2s_v5", location: "westeurope" },
      }),
      warnings,
    );

    expect(result!.type).toBe("azurerm_linux_virtual_machine");
    expect(result!.region).toBe("westeurope");
    expect(result!.attributes.vm_size).toBe("Standard_D2s_v5");
  });

  it("maps azure storage account attributes", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "azure:storage:Account",
        urn: "urn:pulumi:prod::project::azure:storage:Account::sa",
        inputs: {
          accountTier: "Standard",
          accountReplicationType: "LRS",
          location: "eastus",
        },
      }),
      warnings,
    );

    expect(result!.type).toBe("azurerm_storage_account");
    expect(result!.attributes.tier).toBe("Standard");
    expect(result!.attributes.storage_type).toBe("LRS");
  });

  it("maps azure key_vault sku from skuName", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "azure:keyvault:KeyVault",
        urn: "urn:pulumi:prod::project::azure:keyvault:KeyVault::kv",
        inputs: { skuName: "premium", location: "eastus" },
      }),
      warnings,
    );

    expect(result!.attributes.sku).toBe("premium");
  });

  it("maps azure sql database with fixed engine=mssql", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "azure:sql:Database",
        urn: "urn:pulumi:prod::project::azure:sql:Database::db",
        inputs: { location: "eastus" },
      }),
      warnings,
    );
    expect(result!.attributes.engine).toBe("mssql");
  });

  it("defaults azure region to eastus when location is absent", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "azure:compute:VirtualMachine",
        urn: "urn:pulumi:prod::project::azure:compute:VirtualMachine::vm",
        inputs: { vmSize: "Standard_B1s" },
      }),
      warnings,
    );
    expect(result!.region).toBe("eastus");
  });
});

// ---------------------------------------------------------------------------
// GCP attribute extraction
// ---------------------------------------------------------------------------

describe("mapPulumiResource — GCP attributes", () => {
  it("maps gcp compute instance machine_type + region via zone strip", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:compute:Instance",
        urn: "urn:pulumi:prod::project::gcp:compute:Instance::vm",
        inputs: { machineType: "n2-standard-4", zone: "us-central1-a" },
      }),
      warnings,
    );
    expect(result!.region).toBe("us-central1");
    expect(result!.attributes.machine_type).toBe("n2-standard-4");
  });

  it("uses props.region when no zone is provided", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:storage:Bucket",
        urn: "urn:pulumi:prod::project::gcp:storage:Bucket::bkt",
        inputs: { region: "europe-west1", storageClass: "STANDARD" },
      }),
      warnings,
    );
    expect(result!.region).toBe("europe-west1");
    expect(result!.attributes.storage_type).toBe("STANDARD");
  });

  it("defaults GCP region to us-central1 when neither zone nor region is present", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:dns:ManagedZone",
        urn: "urn:pulumi:prod::project::gcp:dns:ManagedZone::zone",
        inputs: {},
      }),
      warnings,
    );
    expect(result!.region).toBe("us-central1");
  });

  it("maps gcp sql database engine + tier from nested settings block", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:sql:DatabaseInstance",
        urn: "urn:pulumi:prod::project::gcp:sql:DatabaseInstance::sql",
        inputs: {
          databaseVersion: "POSTGRES_15",
          settings: { tier: "db-n1-standard-2" },
          region: "us-central1",
        },
      }),
      warnings,
    );
    expect(result!.attributes.engine).toBe("POSTGRES_15");
    expect(result!.attributes.tier).toBe("db-n1-standard-2");
  });

  it("maps gcp container cluster initialNodeCount", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:container:Cluster",
        urn: "urn:pulumi:prod::project::gcp:container:Cluster::k8s",
        inputs: { initialNodeCount: 3, region: "us-central1" },
      }),
      warnings,
    );
    expect(result!.attributes.node_count).toBe(3);
  });

  it("maps gcp cloud function memory + timeout", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "gcp:cloudfunctions:Function",
        urn: "urn:pulumi:prod::project::gcp:cloudfunctions:Function::fn",
        inputs: { availableMemoryMb: 256, timeout: 30, region: "us-central1" },
      }),
      warnings,
    );
    expect(result!.attributes.memory_size).toBe(256);
    expect(result!.attributes.timeout).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Region / AZ handling
// ---------------------------------------------------------------------------

describe("mapPulumiResource — region extraction", () => {
  it("derives AWS region by stripping trailing letters from availabilityZone", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
        outputs: { availabilityZone: "ap-southeast-1b" },
      }),
      warnings,
    );
    expect(result!.region).toBe("ap-southeast-1");
  });

  it("uses props.region for AWS when availabilityZone is absent", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
        inputs: { region: "eu-west-2" },
      }),
      warnings,
    );
    expect(result!.region).toBe("eu-west-2");
  });

  it("defaults AWS region to us-east-1 when neither AZ nor region is provided", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
        inputs: {},
      }),
      warnings,
    );
    expect(result!.region).toBe("us-east-1");
  });
});

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

describe("mapPulumiResource — tag extraction", () => {
  it("keeps only string-valued tag entries", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
        inputs: { tags: { Env: "prod", Cost: 100, Active: true, Null: null } },
      }),
      warnings,
    );
    expect(result!.tags).toEqual({ Env: "prod" });
  });

  it("returns empty tags when 'tags' is an array (invalid shape)", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
        inputs: { tags: ["not", "an", "object"] },
      }),
      warnings,
    );
    expect(result!.tags).toEqual({});
  });

  it("returns empty tags when 'tags' is missing", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:ec2/instance:Instance::vm",
      }),
      warnings,
    );
    expect(result!.tags).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// asNumber: numeric-string coercion
// ---------------------------------------------------------------------------

describe("mapPulumiResource — numeric-string coercion", () => {
  it("parses numeric string values in attribute fields", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ebs/volume:Volume",
        urn: "urn:pulumi:prod::project::aws:ebs/volume:Volume::d",
        inputs: { type: "gp3", size: "250", iops: "3000" },
      }),
      warnings,
    );
    expect(result!.attributes.storage_size_gb).toBe(250);
    expect(result!.attributes.iops).toBe(3000);
  });

  it("drops non-numeric string values", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:ebs/volume:Volume",
        urn: "urn:pulumi:prod::project::aws:ebs/volume:Volume::d",
        inputs: { type: "gp3", size: "abc" },
      }),
      warnings,
    );
    expect(result!.attributes.storage_size_gb).toBeUndefined();
  });

  it("coerces 'true' / 'false' string values to booleans", () => {
    const warnings: string[] = [];
    const resultTrue = mapPulumiResource(
      makeResource({
        type: "aws:rds/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:rds/instance:Instance::db",
        inputs: { multiAz: "true" },
      }),
      warnings,
    );
    const resultFalse = mapPulumiResource(
      makeResource({
        type: "aws:rds/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:rds/instance:Instance::db",
        inputs: { multiAz: "false" },
      }),
      warnings,
    );
    expect(resultTrue!.attributes.multi_az).toBe(true);
    expect(resultFalse!.attributes.multi_az).toBe(false);
  });

  it("drops non-'true'/'false' strings for boolean attributes", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        type: "aws:rds/instance:Instance",
        urn: "urn:pulumi:prod::project::aws:rds/instance:Instance::db",
        inputs: { multiAz: "yes" },
      }),
      warnings,
    );
    expect(result!.attributes.multi_az).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URN parsing
// ---------------------------------------------------------------------------

describe("mapPulumiResource — URN handling", () => {
  it("extracts the resource name from the 4th segment of the URN", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "urn:pulumi:prod::proj::aws:ec2/instance:Instance::web-server-1",
        type: "aws:ec2/instance:Instance",
      }),
      warnings,
    );
    expect(result!.name).toBe("web-server-1");
  });

  it("uses the full URN as name when it has fewer than 4 segments", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      makeResource({
        urn: "short",
        type: "aws:ec2/instance:Instance",
        id: "i-xxx",
      }),
      warnings,
    );
    expect(result!.name).toBe("short");
    expect(result!.id).toBe("i-xxx");
  });

  it("falls back to the parsed name when id is missing", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      {
        urn: "urn:pulumi:prod::proj::aws:s3/bucket:Bucket::my-bucket",
        type: "aws:s3/bucket:Bucket",
        // No id.
      } as PulumiResource,
      warnings,
    );
    expect(result!.id).toBe("my-bucket");
  });
});
