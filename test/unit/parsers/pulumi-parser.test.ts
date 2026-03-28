import { describe, it, expect } from "vitest";
import { PulumiParser } from "../../../src/parsers/pulumi/pulumi-parser.js";
import { mapPulumiResource } from "../../../src/parsers/pulumi/pulumi-resource-mapper.js";
import { detectFormat } from "../../../src/parsers/format-detector.js";
import type { PulumiResource } from "../../../src/parsers/pulumi/pulumi-types.js";

const parser = new PulumiParser();

// ---------------------------------------------------------------------------
// Fixture stack exports
// ---------------------------------------------------------------------------

function makeStackExport(resources: PulumiResource[]) {
  return JSON.stringify({
    version: 3,
    deployment: {
      manifest: { time: "2024-01-01T00:00:00Z", magic: "test" },
      resources,
    },
  });
}

const AWS_STACK = makeStackExport([
  {
    urn: "urn:pulumi:prod::myproject::pulumi:pulumi:Stack::myproject-prod",
    type: "pulumi:pulumi:Stack",
    id: "myproject-prod",
  },
  {
    urn: "urn:pulumi:prod::myproject::pulumi:providers:aws::default",
    type: "pulumi:providers:aws",
    id: "default",
  },
  {
    urn: "urn:pulumi:prod::myproject::aws:ec2/instance:Instance::web-server",
    type: "aws:ec2/instance:Instance",
    id: "i-12345",
    inputs: {
      instanceType: "t3.large",
      ami: "ami-12345",
      tags: { Name: "web" },
    },
    outputs: {
      id: "i-12345",
      instanceType: "t3.large",
      publicIp: "1.2.3.4",
      availabilityZone: "us-east-1a",
    },
  },
  {
    urn: "urn:pulumi:prod::myproject::aws:rds/instance:Instance::db",
    type: "aws:rds/instance:Instance",
    id: "mydb",
    inputs: {
      instanceClass: "db.t3.medium",
      engine: "mysql",
      allocatedStorage: 100,
      multiAz: false,
    },
    outputs: {
      id: "mydb",
      availabilityZone: "us-east-1b",
    },
  },
  {
    urn: "urn:pulumi:prod::myproject::aws:s3/bucket:Bucket::assets",
    type: "aws:s3/bucket:Bucket",
    id: "my-assets-bucket",
    inputs: { tags: { Environment: "prod" } },
    outputs: { id: "my-assets-bucket", region: "us-east-1" },
  },
]);

const AZURE_STACK = makeStackExport([
  {
    urn: "urn:pulumi:prod::myproject::azure:compute:VirtualMachine::app-vm",
    type: "azure:compute:VirtualMachine",
    id: "/subscriptions/xxx/vm/app-vm",
    inputs: { vmSize: "Standard_D2s_v3", location: "westus2", tags: { team: "backend" } },
    outputs: { id: "/subscriptions/xxx/vm/app-vm" },
  },
  {
    urn: "urn:pulumi:prod::myproject::azure:storage:Account::data",
    type: "azure:storage:Account",
    id: "mydata123",
    inputs: { accountTier: "Standard", accountReplicationType: "LRS", location: "westus2" },
    outputs: {},
  },
]);

const GCP_STACK = makeStackExport([
  {
    urn: "urn:pulumi:prod::myproject::gcp:compute:Instance::api-server",
    type: "gcp:compute:Instance",
    id: "api-server-001",
    inputs: { machineType: "n1-standard-4", zone: "us-central1-a" },
    outputs: { id: "api-server-001" },
  },
  {
    urn: "urn:pulumi:prod::myproject::gcp:sql:DatabaseInstance::main-db",
    type: "gcp:sql:DatabaseInstance",
    id: "main-db",
    inputs: {
      databaseVersion: "POSTGRES_14",
      region: "us-central1",
      settings: { tier: "db-custom-4-8192" },
    },
    outputs: {},
  },
]);

const MULTI_CLOUD_STACK = makeStackExport([
  {
    urn: "urn:pulumi:prod::myproject::aws:ec2/instance:Instance::web",
    type: "aws:ec2/instance:Instance",
    id: "i-111",
    inputs: { instanceType: "t3.micro" },
    outputs: { availabilityZone: "us-west-2a" },
  },
  {
    urn: "urn:pulumi:prod::myproject::azure:compute:VirtualMachine::api",
    type: "azure:compute:VirtualMachine",
    id: "vm-222",
    inputs: { vmSize: "Standard_B2s", location: "eastus" },
    outputs: {},
  },
  {
    urn: "urn:pulumi:prod::myproject::gcp:compute:Instance::worker",
    type: "gcp:compute:Instance",
    id: "worker-333",
    inputs: { machineType: "e2-medium", zone: "europe-west1-b" },
    outputs: {},
  },
]);

const EMPTY_STACK = makeStackExport([]);

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("PulumiParser", () => {
  describe("detect", () => {
    it("detects Pulumi stack export JSON", () => {
      expect(parser.detect([{ path: "stack.json", content: AWS_STACK }])).toBe(true);
    });

    it("does not detect non-Pulumi JSON", () => {
      expect(parser.detect([{ path: "data.json", content: JSON.stringify({ foo: "bar" }) }])).toBe(
        false,
      );
    });

    it("does not detect invalid JSON", () => {
      expect(parser.detect([{ path: "bad.json", content: "not json{" }])).toBe(false);
    });
  });

  describe("parse — AWS resources", () => {
    it("parses EC2, RDS, and S3 resources", async () => {
      const result = await parser.parse([{ path: "stack.json", content: AWS_STACK }]);

      expect(result.provider).toBe("aws");
      expect(result.total_count).toBe(3);
      expect(result.by_type).toEqual({
        aws_instance: 1,
        aws_db_instance: 1,
        aws_s3_bucket: 1,
      });

      const ec2 = result.resources.find((r) => r.type === "aws_instance");
      expect(ec2).toBeDefined();
      expect(ec2!.name).toBe("web-server");
      expect(ec2!.id).toBe("i-12345");
      expect(ec2!.attributes.instance_type).toBe("t3.large");
      expect(ec2!.tags).toEqual({ Name: "web" });

      const rds = result.resources.find((r) => r.type === "aws_db_instance");
      expect(rds).toBeDefined();
      expect(rds!.attributes.instance_type).toBe("db.t3.medium");
      expect(rds!.attributes.engine).toBe("mysql");
      expect(rds!.attributes.storage_size_gb).toBe(100);
      expect(rds!.attributes.multi_az).toBe(false);
    });
  });

  describe("parse — Azure resources", () => {
    it("parses VM and storage account", async () => {
      const result = await parser.parse([{ path: "stack.json", content: AZURE_STACK }]);

      expect(result.provider).toBe("azure");
      expect(result.total_count).toBe(2);

      const vm = result.resources.find((r) => r.type === "azurerm_linux_virtual_machine");
      expect(vm).toBeDefined();
      expect(vm!.attributes.vm_size).toBe("Standard_D2s_v3");
      expect(vm!.region).toBe("westus2");
      expect(vm!.tags).toEqual({ team: "backend" });

      const storage = result.resources.find((r) => r.type === "azurerm_storage_account");
      expect(storage).toBeDefined();
      expect(storage!.attributes.tier).toBe("Standard");
      expect(storage!.attributes.storage_type).toBe("LRS");
    });
  });

  describe("parse — GCP resources", () => {
    it("parses compute instance and SQL database", async () => {
      const result = await parser.parse([{ path: "stack.json", content: GCP_STACK }]);

      expect(result.provider).toBe("gcp");
      expect(result.total_count).toBe(2);

      const compute = result.resources.find((r) => r.type === "google_compute_instance");
      expect(compute).toBeDefined();
      expect(compute!.attributes.machine_type).toBe("n1-standard-4");
      expect(compute!.region).toBe("us-central1");

      const sql = result.resources.find((r) => r.type === "google_sql_database_instance");
      expect(sql).toBeDefined();
      expect(sql!.attributes.engine).toBe("POSTGRES_14");
      expect(sql!.attributes.tier).toBe("db-custom-4-8192");
    });
  });

  describe("parse — multi-cloud", () => {
    it("handles resources from multiple providers", async () => {
      const result = await parser.parse([{ path: "stack.json", content: MULTI_CLOUD_STACK }]);

      expect(result.total_count).toBe(3);
      const providers = new Set(result.resources.map((r) => r.provider));
      expect(providers).toEqual(new Set(["aws", "azure", "gcp"]));
    });
  });

  describe("parse — skips internal resources", () => {
    it("filters out pulumi:pulumi:Stack and pulumi:providers:* resources", async () => {
      const result = await parser.parse([{ path: "stack.json", content: AWS_STACK }]);

      // The stack export has 5 resources total but 2 are internal
      const types = result.resources.map((r) => r.type);
      expect(types).not.toContain("pulumi:pulumi:Stack");
      expect(types.every((t) => !t.startsWith("pulumi:"))).toBe(true);
      expect(result.total_count).toBe(3);
    });
  });

  describe("parse — empty deployment", () => {
    it("returns empty inventory for empty resource list", async () => {
      const result = await parser.parse([{ path: "stack.json", content: EMPTY_STACK }]);

      expect(result.total_count).toBe(0);
      expect(result.resources).toEqual([]);
      expect(result.provider).toBe("aws");
    });
  });

  describe("parse — invalid JSON", () => {
    it("returns empty inventory with warning for non-JSON input", async () => {
      const result = await parser.parse([{ path: "bad.json", content: "not json{" }]);

      expect(result.total_count).toBe(0);
      expect(result.resources).toEqual([]);
    });
  });

  describe("parse — region extraction", () => {
    it("extracts AWS region from availability zone", async () => {
      const result = await parser.parse([{ path: "stack.json", content: AWS_STACK }]);
      const ec2 = result.resources.find((r) => r.type === "aws_instance");

      expect(ec2!.region).toBe("us-east-1");
    });

    it("extracts GCP region from zone", async () => {
      const result = await parser.parse([{ path: "stack.json", content: GCP_STACK }]);
      const compute = result.resources.find((r) => r.type === "google_compute_instance");

      expect(compute!.region).toBe("us-central1");
    });

    it("uses Azure location directly", async () => {
      const result = await parser.parse([{ path: "stack.json", content: AZURE_STACK }]);
      const vm = result.resources.find((r) => r.type === "azurerm_linux_virtual_machine");

      expect(vm!.region).toBe("westus2");
    });
  });
});

// ---------------------------------------------------------------------------
// Resource mapper unit tests
// ---------------------------------------------------------------------------

describe("mapPulumiResource", () => {
  it("returns null for unsupported resource types", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      {
        urn: "urn:pulumi:prod::proj::aws:cloudwatch/logGroup:LogGroup::logs",
        type: "aws:cloudwatch/logGroup:LogGroup",
      },
      warnings,
    );

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unsupported Pulumi resource type");
  });

  it("extracts name from URN", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      {
        urn: "urn:pulumi:dev::myapp::aws:s3/bucket:Bucket::my-bucket",
        type: "aws:s3/bucket:Bucket",
        id: "my-bucket-id",
        inputs: {},
        outputs: {},
      },
      warnings,
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-bucket");
  });

  it("uses resource id when available", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      {
        urn: "urn:pulumi:dev::proj::aws:ec2/instance:Instance::web",
        type: "aws:ec2/instance:Instance",
        id: "i-abc123",
        inputs: { instanceType: "t3.small" },
        outputs: {},
      },
      warnings,
    );

    expect(result!.id).toBe("i-abc123");
  });

  it("falls back to name as id when resource id is missing", () => {
    const warnings: string[] = [];
    const result = mapPulumiResource(
      {
        urn: "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::data",
        type: "aws:s3/bucket:Bucket",
        inputs: {},
      },
      warnings,
    );

    expect(result!.id).toBe("data");
  });
});

// ---------------------------------------------------------------------------
// Format detector integration
// ---------------------------------------------------------------------------

describe("format detector — Pulumi", () => {
  it("auto-detects Pulumi stack export via detectFormat", () => {
    const detected = detectFormat([{ path: "stack.json", content: AWS_STACK }]);

    expect(detected).not.toBeNull();
    expect(detected!.name).toBe("Pulumi");
  });

  it("does not detect Pulumi for plain JSON", () => {
    const detected = detectFormat([
      { path: "data.json", content: JSON.stringify({ items: [1, 2, 3] }) },
    ]);

    // Should not match Pulumi (may match nothing or another parser)
    if (detected) {
      expect(detected.name).not.toBe("Pulumi");
    }
  });
});
