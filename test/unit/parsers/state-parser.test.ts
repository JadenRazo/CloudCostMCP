import { describe, it, expect } from "vitest";
import { parseTerraformState } from "../../../src/parsers/terraform/state-parser.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 4,
    terraform_version: "1.5.0",
    serial: 42,
    lineage: "abc-123",
    resources: [],
    ...overrides,
  });
}

function makeResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "managed",
    type: "aws_instance",
    name: "web",
    provider: 'provider["registry.terraform.io/hashicorp/aws"]',
    instances: [
      {
        attributes: {
          id: "i-12345",
          instance_type: "t3.large",
          ami: "ami-12345",
          availability_zone: "us-east-1a",
          tags: { Name: "web", Environment: "production" },
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseTerraformState", () => {
  // -------------------------------------------------------------------------
  // AWS resources
  // -------------------------------------------------------------------------

  it("parses state with AWS resources", () => {
    const state = makeState({
      resources: [
        makeResource(),
        makeResource({
          type: "aws_db_instance",
          name: "main",
          instances: [
            {
              attributes: {
                id: "db-12345",
                instance_class: "db.t3.medium",
                engine: "postgres",
                engine_version: "14.3",
                allocated_storage: 100,
                multi_az: true,
                availability_zone: "us-east-1a",
              },
            },
          ],
        }),
      ],
    });

    const result = parseTerraformState(state);

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("us-east-1");
    expect(result.total_count).toBe(2);
    expect(result.resources).toHaveLength(2);

    const ec2 = result.resources.find((r) => r.type === "aws_instance");
    expect(ec2).toBeDefined();
    expect(ec2!.id).toBe("aws_instance.web");
    expect(ec2!.attributes.instance_type).toBe("t3.large");
    expect(ec2!.tags).toEqual({ Name: "web", Environment: "production" });

    const rds = result.resources.find((r) => r.type === "aws_db_instance");
    expect(rds).toBeDefined();
    expect(rds!.attributes.instance_type).toBe("db.t3.medium");
    expect(rds!.attributes.engine).toBe("postgres");
    expect(rds!.attributes.storage_size_gb).toBe(100);
    expect(rds!.attributes.multi_az).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Azure resources
  // -------------------------------------------------------------------------

  it("parses state with Azure resources", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "azurerm_virtual_machine",
          name: "main",
          provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
          instances: [
            {
              attributes: {
                id: "/subscriptions/xxx/vm/main",
                vm_size: "Standard_D2s_v3",
                location: "eastus2",
                tags: { team: "backend" },
              },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.provider).toBe("azure");
    expect(result.region).toBe("eastus2");
    expect(result.total_count).toBe(1);

    const vm = result.resources[0];
    expect(vm.attributes.vm_size).toBe("Standard_D2s_v3");
    expect(vm.tags).toEqual({ team: "backend" });
  });

  // -------------------------------------------------------------------------
  // GCP resources
  // -------------------------------------------------------------------------

  it("parses state with GCP resources", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "google_compute_instance",
          name: "app",
          provider: 'provider["registry.terraform.io/hashicorp/google"]',
          instances: [
            {
              attributes: {
                id: "projects/my-project/zones/us-central1-a/instances/app",
                machine_type: "e2-standard-4",
                zone: "us-central1-a",
                tags: {},
              },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.provider).toBe("gcp");
    expect(result.region).toBe("us-central1");
    expect(result.total_count).toBe(1);

    const instance = result.resources[0];
    expect(instance.attributes.machine_type).toBe("e2-standard-4");
    expect(instance.region).toBe("us-central1");
  });

  // -------------------------------------------------------------------------
  // Multiple instances (count / for_each)
  // -------------------------------------------------------------------------

  it("handles multiple instances from count expansion", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "aws_instance",
          name: "worker",
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [
            {
              index_key: 0,
              attributes: {
                id: "i-001",
                instance_type: "t3.medium",
                availability_zone: "us-east-1a",
              },
            },
            {
              index_key: 1,
              attributes: {
                id: "i-002",
                instance_type: "t3.medium",
                availability_zone: "us-east-1b",
              },
            },
            {
              index_key: 2,
              attributes: {
                id: "i-003",
                instance_type: "t3.medium",
                availability_zone: "us-east-1c",
              },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.total_count).toBe(3);
    expect(result.resources.map((r) => r.id)).toEqual([
      "aws_instance.worker[0]",
      "aws_instance.worker[1]",
      "aws_instance.worker[2]",
    ]);
  });

  it("handles for_each string keys", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "aws_s3_bucket",
          name: "data",
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [
            {
              index_key: "logs",
              attributes: { id: "my-logs-bucket", bucket: "my-logs-bucket" },
            },
            {
              index_key: "assets",
              attributes: { id: "my-assets-bucket", bucket: "my-assets-bucket" },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.total_count).toBe(2);
    expect(result.resources.map((r) => r.id)).toEqual([
      'aws_s3_bucket.data["logs"]',
      'aws_s3_bucket.data["assets"]',
    ]);
  });

  // -------------------------------------------------------------------------
  // Skip data sources
  // -------------------------------------------------------------------------

  it("skips data sources (mode: data)", () => {
    const state = makeState({
      resources: [
        makeResource(),
        {
          mode: "data",
          type: "aws_ami",
          name: "latest",
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [
            {
              attributes: { id: "ami-99999", image_id: "ami-99999" },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.total_count).toBe(1);
    expect(result.resources[0].type).toBe("aws_instance");
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it("handles empty state with no resources", () => {
    const state = makeState({ resources: [] });
    const result = parseTerraformState(state);

    expect(result.total_count).toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.provider).toBe("aws");
    expect(result.parse_warnings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  it("handles invalid JSON gracefully", () => {
    const result = parseTerraformState("not valid json {{{");

    expect(result.total_count).toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.parse_warnings.length).toBeGreaterThan(0);
    expect(result.parse_warnings[0]).toMatch(/Invalid state JSON/);
  });

  // -------------------------------------------------------------------------
  // by_type aggregation
  // -------------------------------------------------------------------------

  it("populates by_type counts", () => {
    const state = makeState({
      resources: [
        makeResource(),
        makeResource({ name: "api" }),
        makeResource({
          type: "aws_ebs_volume",
          name: "data",
          instances: [
            {
              attributes: {
                id: "vol-123",
                size: 100,
                type: "gp3",
                availability_zone: "us-east-1a",
              },
            },
          ],
        }),
      ],
    });

    const result = parseTerraformState(state);

    expect(result.by_type).toEqual({
      aws_instance: 2,
      aws_ebs_volume: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Unknown provider warning
  // -------------------------------------------------------------------------

  it("warns on unknown provider and skips the resource", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "custom_resource",
          name: "thing",
          provider: 'provider["registry.terraform.io/acme/custom"]',
          instances: [{ attributes: { id: "x" } }],
        },
      ],
    });

    const result = parseTerraformState(state);

    expect(result.total_count).toBe(0);
    expect(result.parse_warnings.some((w) => w.includes("unknown provider"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // EBS volume storage_type extraction
  // -------------------------------------------------------------------------

  it("extracts storage_type from EBS volume type attribute", () => {
    const state = makeState({
      resources: [
        {
          mode: "managed",
          type: "aws_ebs_volume",
          name: "data",
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [
            {
              attributes: {
                id: "vol-123",
                size: 200,
                type: "gp3",
                availability_zone: "us-west-2a",
                iops: 3000,
                throughput: 125,
              },
            },
          ],
        },
      ],
    });

    const result = parseTerraformState(state);
    const vol = result.resources[0];

    expect(vol.attributes.storage_type).toBe("gp3");
    expect(vol.attributes.storage_size_gb).toBe(200);
    expect(vol.attributes.iops).toBe(3000);
    expect(vol.attributes.throughput_mbps).toBe(125);
    expect(vol.region).toBe("us-west-2");
  });
});
