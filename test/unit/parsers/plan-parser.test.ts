import { describe, it, expect } from "vitest";
import { parseTerraformPlan } from "../../../src/parsers/terraform/plan-parser.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: "1.0",
    terraform_version: "1.5.0",
    resource_changes: [],
    ...overrides,
  });
}

function makeResourceChange(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "aws_instance.web",
    type: "aws_instance",
    name: "web",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: {
      actions: ["create"],
      before: null,
      after: { instance_type: "t3.large", ami: "ami-12345" },
      after_unknown: { id: true, arn: true },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseTerraformPlan", () => {
  it("parses a create-only plan", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange(),
        makeResourceChange({
          address: "aws_ebs_volume.data",
          type: "aws_ebs_volume",
          name: "data",
          change: {
            actions: ["create"],
            before: null,
            after: { size: 100, type: "gp3", availability_zone: "us-east-1a" },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.summary.creates).toBe(2);
    expect(result.summary.deletes).toBe(0);
    expect(result.summary.updates).toBe(0);
    expect(result.summary.replaces).toBe(0);
    expect(result.summary.no_ops).toBe(0);

    expect(result.before.resources).toHaveLength(0);
    expect(result.after.resources).toHaveLength(2);

    // Check attributes were extracted
    const instance = result.after.resources.find((r) => r.type === "aws_instance");
    expect(instance).toBeDefined();
    expect(instance!.attributes.instance_type).toBe("t3.large");

    const volume = result.after.resources.find((r) => r.type === "aws_ebs_volume");
    expect(volume).toBeDefined();
    expect(volume!.attributes.storage_size_gb).toBe(100);
    expect(volume!.region).toBe("us-east-1");
  });

  it("parses a delete-only plan", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["delete"],
            before: { instance_type: "t3.micro", ami: "ami-old" },
            after: null,
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.summary.deletes).toBe(1);
    expect(result.summary.creates).toBe(0);
    expect(result.before.resources).toHaveLength(1);
    expect(result.after.resources).toHaveLength(0);
    expect(result.before.resources[0].attributes.instance_type).toBe("t3.micro");
  });

  it("parses an update plan", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["update"],
            before: { instance_type: "t3.micro", ami: "ami-old" },
            after: { instance_type: "t3.large", ami: "ami-old" },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.summary.updates).toBe(1);
    expect(result.before.resources).toHaveLength(1);
    expect(result.after.resources).toHaveLength(1);
    expect(result.before.resources[0].attributes.instance_type).toBe("t3.micro");
    expect(result.after.resources[0].attributes.instance_type).toBe("t3.large");
  });

  it("parses a replace plan (create+delete)", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["delete", "create"],
            before: { instance_type: "t3.micro" },
            after: { instance_type: "t3.large" },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.summary.replaces).toBe(1);
    expect(result.changes[0].action).toBe("replace");
  });

  it("parses mixed actions", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          address: "aws_instance.create_me",
          change: {
            actions: ["create"],
            before: null,
            after: { instance_type: "t3.large" },
          },
        }),
        makeResourceChange({
          address: "aws_instance.update_me",
          change: {
            actions: ["update"],
            before: { instance_type: "t3.micro" },
            after: { instance_type: "t3.large" },
          },
        }),
        makeResourceChange({
          address: "aws_instance.delete_me",
          change: {
            actions: ["delete"],
            before: { instance_type: "t3.small" },
            after: null,
          },
        }),
        makeResourceChange({
          address: "aws_instance.noop",
          change: {
            actions: ["no-op"],
            before: { instance_type: "t3.nano" },
            after: { instance_type: "t3.nano" },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.summary.creates).toBe(1);
    expect(result.summary.updates).toBe(1);
    expect(result.summary.deletes).toBe(1);
    expect(result.summary.no_ops).toBe(1);

    // before has update_me + delete_me + noop = 3
    expect(result.before.resources).toHaveLength(3);
    // after has create_me + update_me + noop = 3
    expect(result.after.resources).toHaveLength(3);
  });

  it("handles an empty plan", () => {
    const plan = makePlan({ resource_changes: [] });
    const result = parseTerraformPlan(plan);

    expect(result.before.resources).toHaveLength(0);
    expect(result.after.resources).toHaveLength(0);
    expect(result.summary.creates).toBe(0);
    expect(result.summary.deletes).toBe(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTerraformPlan("not json")).toThrow("Invalid plan JSON");
  });

  it("throws when resource_changes is missing", () => {
    expect(() => parseTerraformPlan(JSON.stringify({ format_version: "1.0" }))).toThrow(
      "missing or non-array resource_changes",
    );
  });

  it("detects Azure provider and region", () => {
    const plan = makePlan({
      resource_changes: [
        {
          address: "azurerm_linux_virtual_machine.web",
          type: "azurerm_linux_virtual_machine",
          name: "web",
          provider_name: "registry.terraform.io/hashicorp/azurerm",
          change: {
            actions: ["create"],
            before: null,
            after: { vm_size: "Standard_B2s", location: "westeurope" },
          },
        },
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.after.resources[0].provider).toBe("azure");
    expect(result.after.resources[0].region).toBe("westeurope");
    expect(result.after.resources[0].attributes.vm_size).toBe("Standard_B2s");
  });

  it("detects GCP provider and region from zone", () => {
    const plan = makePlan({
      resource_changes: [
        {
          address: "google_compute_instance.web",
          type: "google_compute_instance",
          name: "web",
          provider_name: "registry.terraform.io/hashicorp/google",
          change: {
            actions: ["create"],
            before: null,
            after: { machine_type: "n1-standard-2", zone: "us-central1-a" },
          },
        },
      ],
    });

    const result = parseTerraformPlan(plan);

    expect(result.after.resources[0].provider).toBe("gcp");
    expect(result.after.resources[0].region).toBe("us-central1");
    expect(result.after.resources[0].attributes.machine_type).toBe("n1-standard-2");
  });

  it("extracts tags from resource attributes", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["create"],
            before: null,
            after: {
              instance_type: "t3.micro",
              tags: { Name: "web", Environment: "prod" },
            },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);
    expect(result.after.resources[0].tags).toEqual({
      Name: "web",
      Environment: "prod",
    });
  });

  it("classifies read actions as no-op", () => {
    const plan = makePlan({
      resource_changes: [
        makeResourceChange({
          change: {
            actions: ["read"],
            before: { instance_type: "t3.micro" },
            after: { instance_type: "t3.micro" },
          },
        }),
      ],
    });

    const result = parseTerraformPlan(plan);
    expect(result.summary.no_ops).toBe(1);
    expect(result.changes[0].action).toBe("no-op");
  });
});
