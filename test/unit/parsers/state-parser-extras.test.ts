import { describe, it, expect } from "vitest";
import { parseTerraformState } from "../../../src/parsers/terraform/state-parser.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeState(resources: Record<string, unknown>[]): string {
  return JSON.stringify({
    version: 4,
    terraform_version: "1.5.0",
    serial: 1,
    lineage: "lin",
    resources,
  });
}

function awsResource(type: string, name: string, attributes: Record<string, unknown>) {
  return {
    mode: "managed",
    type,
    name,
    provider: 'provider["registry.terraform.io/hashicorp/aws"]',
    instances: [{ attributes }],
  };
}

function azureResource(type: string, name: string, attributes: Record<string, unknown>) {
  return {
    mode: "managed",
    type,
    name,
    provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
    instances: [{ attributes }],
  };
}

function gcpResource(type: string, name: string, attributes: Record<string, unknown>) {
  return {
    mode: "managed",
    type,
    name,
    provider: 'provider["registry.terraform.io/hashicorp/google"]',
    instances: [{ attributes }],
  };
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

describe("parseTerraformState — provider detection fallbacks", () => {
  it("detects google-beta as gcp provider", () => {
    const state = makeState([
      {
        mode: "managed",
        type: "google_compute_instance",
        name: "vm",
        provider: 'provider["registry.terraform.io/hashicorp/google-beta"]',
        instances: [{ attributes: { machine_type: "n2-standard-2", zone: "us-central1-a" } }],
      },
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].provider).toBe("gcp");
  });

  it("warns and skips resources with unknown providers", () => {
    const state = makeState([
      {
        mode: "managed",
        type: "custom_thing",
        name: "x",
        provider: 'provider["example.com/acme/custom"]',
        instances: [{ attributes: {} }],
      },
      // A recognised AWS resource so the result isn't empty.
      awsResource("aws_instance", "web", { instance_type: "t3.small" }),
    ]);
    const inv = parseTerraformState(state);

    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].type).toBe("aws_instance");
    expect(inv.parse_warnings.some((w) => w.includes("unknown provider"))).toBe(true);
  });

  it("skips data-source resources (mode != 'managed')", () => {
    const state = makeState([
      {
        mode: "data",
        type: "aws_ami",
        name: "latest",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: { id: "ami-xxx" } }],
      },
      awsResource("aws_instance", "web", { instance_type: "t3.small" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].type).toBe("aws_instance");
  });

  it("skips resources whose instances field is not an array", () => {
    const state = makeState([
      {
        mode: "managed",
        type: "aws_instance",
        name: "bad",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: "not-an-array",
      },
      awsResource("aws_instance", "ok", { instance_type: "t3.micro" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].name).toBe("ok");
  });

  it("uses the provider-address matcher fallback when the regex misses", () => {
    // An oddly-formatted provider string where the regex at line 34 fails
    // but the includes() fallback still detects 'aws'.
    const state = makeState([
      {
        mode: "managed",
        type: "aws_instance",
        name: "x",
        // Trailing content after the closing bracket won't match the regex.
        provider: 'provider["registry.terraform.io/hashicorp/aws"] /* comment */',
        instances: [{ attributes: { instance_type: "t3.micro" } }],
      },
    ]);
    const inv = parseTerraformState(state);
    // The includes('/aws"') fallback path is exercised.
    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].provider).toBe("aws");
  });
});

// ---------------------------------------------------------------------------
// Region detection paths
// ---------------------------------------------------------------------------

describe("parseTerraformState — region detection", () => {
  it("AWS: region attribute when no availability_zone is present", () => {
    const state = makeState([awsResource("aws_s3_bucket", "b", { region: "eu-west-1" })]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("eu-west-1");
  });

  it("AWS: defaults to us-east-1 when neither AZ nor region is present", () => {
    const state = makeState([awsResource("aws_s3_bucket", "b", {})]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("us-east-1");
  });

  it("Azure: uses location attribute when present", () => {
    const state = makeState([
      azureResource("azurerm_virtual_machine", "vm", {
        vm_size: "Standard_D2s_v5",
        location: "westeurope",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("westeurope");
  });

  it("Azure: defaults to eastus when no location present", () => {
    const state = makeState([
      azureResource("azurerm_virtual_machine", "vm", { vm_size: "Standard_B1s" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("eastus");
  });

  it("GCP: strips trailing -a/-b from zones with >2 segments", () => {
    const state = makeState([
      gcpResource("google_compute_instance", "vm", {
        machine_type: "n2-standard-2",
        zone: "europe-west1-a",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("europe-west1");
  });

  it("GCP: zones with only 2 segments are returned as-is", () => {
    const state = makeState([
      gcpResource("google_compute_instance", "vm", {
        machine_type: "n2-standard-2",
        zone: "us-a",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("us-a");
  });

  it("GCP: falls back to region attribute when no zone is present", () => {
    const state = makeState([
      gcpResource("google_storage_bucket", "b", {
        storage_class: "STANDARD",
        region: "asia-southeast1",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("asia-southeast1");
  });

  it("GCP: defaults to us-central1 when neither zone nor region is present", () => {
    const state = makeState([gcpResource("google_storage_bucket", "b", {})]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].region).toBe("us-central1");
  });
});

// ---------------------------------------------------------------------------
// Attribute extraction paths
// ---------------------------------------------------------------------------

describe("parseTerraformState — attribute extraction", () => {
  it("extracts RDS instance_class into instance_type", () => {
    const state = makeState([
      awsResource("aws_db_instance", "db", {
        instance_class: "db.t3.medium",
        engine: "postgres",
        engine_version: "15.4",
        allocated_storage: 100,
        multi_az: true,
        replicas: 2,
      }),
    ]);
    const inv = parseTerraformState(state);
    const r = inv.resources[0];
    expect(r.attributes.instance_type).toBe("db.t3.medium");
    expect(r.attributes.engine).toBe("postgres");
    expect(r.attributes.engine_version).toBe("15.4");
    expect(r.attributes.storage_size_gb).toBe(100);
    expect(r.attributes.multi_az).toBe(true);
    expect(r.attributes.replicas).toBe(2);
  });

  it("uses 'size' attribute as storage_size_gb when allocated_storage is absent", () => {
    const state = makeState([
      awsResource("aws_ebs_volume", "d", {
        type: "gp3",
        size: 500,
        iops: 3000,
        throughput: 250,
        availability_zone: "us-east-1a",
      }),
    ]);
    const inv = parseTerraformState(state);
    const r = inv.resources[0];
    expect(r.attributes.storage_size_gb).toBe(500);
    expect(r.attributes.iops).toBe(3000);
    expect(r.attributes.throughput_mbps).toBe(250);
    // aws_ebs_volume uses the "type" attribute as storage_type
    expect(r.attributes.storage_type).toBe("gp3");
  });

  it("uses storage_type from attrs when available (takes priority over ebs type fallback)", () => {
    const state = makeState([
      awsResource("aws_ebs_volume", "d", {
        type: "gp3",
        storage_type: "io2",
        size: 100,
        availability_zone: "us-east-1a",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].attributes.storage_type).toBe("io2");
  });

  it("does not set storage_type for non-EBS types when only 'type' is set", () => {
    const state = makeState([
      awsResource("aws_elb", "lb", {
        type: "application",
      }),
    ]);
    const inv = parseTerraformState(state);
    // For non-EBS, the "type" field isn't translated into storage_type.
    expect(inv.resources[0].attributes.storage_type).toBeUndefined();
  });

  it("extracts tier / sku / sku_name", () => {
    const state = makeState([
      awsResource("aws_db_instance", "db", {
        instance_class: "db.t3.small",
        tier: "Standard",
      }),
      azureResource("azurerm_storage_account", "sa", {
        location: "eastus",
        sku: "Premium",
      }),
      azureResource("azurerm_key_vault", "kv", {
        location: "eastus",
        sku_name: "premium",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].attributes.tier).toBe("Standard");
    expect(inv.resources[1].attributes.sku).toBe("Premium");
    expect(inv.resources[2].attributes.sku).toBe("premium"); // sku_name → sku
  });

  it("extracts scaling node_count / min / max", () => {
    const state = makeState([
      awsResource("aws_eks_node_group", "ng", {
        node_count: 3,
        min_node_count: 1,
        max_node_count: 10,
      }),
    ]);
    const inv = parseTerraformState(state);
    const r = inv.resources[0];
    expect(r.attributes.node_count).toBe(3);
    expect(r.attributes.min_node_count).toBe(1);
    expect(r.attributes.max_node_count).toBe(10);
  });

  it("extracts os_type into the os attribute", () => {
    const state = makeState([
      azureResource("azurerm_virtual_machine", "vm", {
        vm_size: "Standard_B1s",
        location: "eastus",
        os_type: "Linux",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].attributes.os).toBe("Linux");
  });

  it("extracts load_balancer_type and internal", () => {
    const state = makeState([
      awsResource("aws_lb", "lb", {
        load_balancer_type: "network",
        internal: true,
      }),
    ]);
    const inv = parseTerraformState(state);
    const r = inv.resources[0];
    expect(r.attributes.load_balancer_type).toBe("network");
    expect(r.attributes.internal).toBe(true);
  });

  it("extracts machine_type for GCP compute instances", () => {
    const state = makeState([
      gcpResource("google_compute_instance", "vm", {
        machine_type: "n2-standard-4",
        zone: "us-central1-a",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].attributes.machine_type).toBe("n2-standard-4");
  });
});

// ---------------------------------------------------------------------------
// Tag extraction edges
// ---------------------------------------------------------------------------

describe("parseTerraformState — tags", () => {
  it("stringifies non-string tag values", () => {
    const state = makeState([
      awsResource("aws_instance", "v", {
        instance_type: "t3.small",
        tags: { Count: 42, Active: true, Env: "prod" },
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].tags).toEqual({
      Count: "42",
      Active: "true",
      Env: "prod",
    });
  });

  it("skips null/undefined tag values", () => {
    const state = makeState([
      awsResource("aws_instance", "v", {
        instance_type: "t3.small",
        tags: { Kept: "yes", Nulled: null },
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].tags).toEqual({ Kept: "yes" });
  });

  it("returns empty tags when tags is an array (wrong shape)", () => {
    const state = makeState([
      awsResource("aws_instance", "v", {
        instance_type: "t3.small",
        tags: ["a", "b"],
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].tags).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Count / for_each expansion and index_key formatting
// ---------------------------------------------------------------------------

describe("parseTerraformState — instance expansion", () => {
  it("formats numeric index_key as [N]", () => {
    const state = makeState([
      {
        mode: "managed",
        type: "aws_instance",
        name: "cluster",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          { index_key: 0, attributes: { instance_type: "t3.small" } },
          { index_key: 1, attributes: { instance_type: "t3.small" } },
        ],
      },
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources.map((r) => r.id)).toEqual([
      "aws_instance.cluster[0]",
      "aws_instance.cluster[1]",
    ]);
  });

  it('formats string index_key as ["key"]', () => {
    const state = makeState([
      {
        mode: "managed",
        type: "aws_instance",
        name: "by_region",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          { index_key: "east", attributes: { instance_type: "t3.small" } },
          { index_key: "west", attributes: { instance_type: "t3.small" } },
        ],
      },
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources.map((r) => r.id)).toEqual([
      'aws_instance.by_region["east"]',
      'aws_instance.by_region["west"]',
    ]);
  });

  it("does not append brackets when index_key is undefined", () => {
    const state = makeState([
      awsResource("aws_instance", "singleton", { instance_type: "t3.small" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources[0].id).toBe("aws_instance.singleton");
  });
});

// ---------------------------------------------------------------------------
// Dominant-provider selection & overall defaults
// ---------------------------------------------------------------------------

describe("parseTerraformState — dominant provider / region", () => {
  it("picks the most common provider when the state has multiple", () => {
    const state = makeState([
      awsResource("aws_instance", "a", { instance_type: "t3.small" }),
      awsResource("aws_instance", "b", { instance_type: "t3.small" }),
      azureResource("azurerm_virtual_machine", "vm", {
        vm_size: "Standard_B1s",
        location: "eastus",
      }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.provider).toBe("aws");
  });

  it("uses the first resource's region of the dominant provider", () => {
    const state = makeState([
      awsResource("aws_instance", "a", {
        instance_type: "t3.small",
        availability_zone: "eu-west-1b",
      }),
      awsResource("aws_instance", "b", { instance_type: "t3.small" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.region).toBe("eu-west-1");
  });

  it("defaults provider and region when no managed resources exist", () => {
    const state = makeState([]);
    const inv = parseTerraformState(state);
    expect(inv.provider).toBe("aws");
    expect(inv.region).toBe("us-east-1");
    expect(inv.total_count).toBe(0);
    expect(inv.resources).toHaveLength(0);
  });

  it("populates by_type counts per resource type", () => {
    const state = makeState([
      awsResource("aws_instance", "a", { instance_type: "t3.small" }),
      awsResource("aws_instance", "b", { instance_type: "t3.small" }),
      awsResource("aws_db_instance", "db", { instance_class: "db.t3.small" }),
    ]);
    const inv = parseTerraformState(state);
    expect(inv.by_type).toEqual({ aws_instance: 2, aws_db_instance: 1 });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("parseTerraformState — error handling", () => {
  it("returns an empty inventory with a parse_warning when JSON is invalid", () => {
    const inv = parseTerraformState("not { valid } json {{{");
    expect(inv.resources).toHaveLength(0);
    expect(inv.total_count).toBe(0);
    expect(inv.parse_warnings.some((w) => w.includes("Invalid state JSON"))).toBe(true);
  });

  it("returns an empty inventory when resources is not an array", () => {
    const state = JSON.stringify({
      version: 4,
      terraform_version: "1.5.0",
      serial: 1,
      lineage: "x",
      resources: { not: "an array" },
    });
    const inv = parseTerraformState(state);
    expect(inv.resources).toHaveLength(0);
  });

  it("treats missing attributes as an empty object", () => {
    const state = makeState([
      {
        mode: "managed",
        type: "aws_instance",
        name: "bare",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{}], // no attributes key
      },
    ]);
    const inv = parseTerraformState(state);
    expect(inv.resources).toHaveLength(1);
    expect(inv.resources[0].attributes).toEqual({});
  });
});
