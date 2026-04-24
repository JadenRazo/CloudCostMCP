import { describe, it, expect } from "vitest";
import {
  extractResources,
  detectRegionFromProviders,
} from "../../../src/parsers/resource-extractor.js";

// ---------------------------------------------------------------------------
// detectRegionFromProviders
// ---------------------------------------------------------------------------

describe("detectRegionFromProviders", () => {
  it("returns the region from a valid AWS provider block", () => {
    const hcl = {
      provider: {
        aws: [{ region: "eu-west-1" }],
      },
    };
    expect(detectRegionFromProviders(hcl, "aws", {})).toBe("eu-west-1");
  });

  it("returns the location from a valid Azure provider block", () => {
    const hcl = {
      provider: {
        azurerm: [{ location: "westeurope" }],
      },
    };
    expect(detectRegionFromProviders(hcl, "azure", {})).toBe("westeurope");
  });

  it("returns the region from a valid GCP provider block", () => {
    const hcl = {
      provider: {
        google: [{ region: "asia-east1" }],
      },
    };
    expect(detectRegionFromProviders(hcl, "gcp", {})).toBe("asia-east1");
  });

  it("resolves a variable reference in the region value", () => {
    const hcl = {
      provider: {
        aws: [{ region: "${var.region}" }],
      },
    };
    const variables = { region: "ap-southeast-1" };
    expect(detectRegionFromProviders(hcl, "aws", variables)).toBe("ap-southeast-1");
  });

  it("falls back to default when variable cannot be resolved", () => {
    const hcl = {
      provider: {
        aws: [{ region: "${var.unknown_var}" }],
      },
    };
    expect(detectRegionFromProviders(hcl, "aws", {})).toBe("us-east-1");
  });

  it("falls back to default when provider block is missing", () => {
    expect(detectRegionFromProviders({}, "aws", {})).toBe("us-east-1");
    expect(detectRegionFromProviders({}, "azure", {})).toBe("eastus");
    expect(detectRegionFromProviders({}, "gcp", {})).toBe("us-central1");
  });

  it("falls back to default when provider key is absent from block", () => {
    const hcl = {
      provider: {
        aws: [{ region: "us-west-2" }],
      },
    };
    // Asking for GCP, but only AWS is declared
    expect(detectRegionFromProviders(hcl, "gcp", {})).toBe("us-central1");
  });

  it("falls back to default when region attribute is missing from declaration", () => {
    const hcl = {
      provider: {
        aws: [{ profile: "dev" }],
      },
    };
    expect(detectRegionFromProviders(hcl, "aws", {})).toBe("us-east-1");
  });

  it("falls back to default when provider block is not an object", () => {
    const hcl = { provider: "invalid" };
    expect(detectRegionFromProviders(hcl as unknown as Record<string, unknown>, "aws", {})).toBe(
      "us-east-1",
    );
  });

  it("falls back to default when declarations array is empty", () => {
    const hcl = {
      provider: {
        aws: [],
      },
    };
    expect(detectRegionFromProviders(hcl, "aws", {})).toBe("us-east-1");
  });
});

// ---------------------------------------------------------------------------
// extractResources
// ---------------------------------------------------------------------------

describe("extractResources", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("extracts a single AWS instance resource", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [
            {
              instance_type: "t3.large",
              ami: "ami-12345678",
              tags: { Name: "web-server" },
            },
          ],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("aws_instance.web");
    expect(results[0].type).toBe("aws_instance");
    expect(results[0].name).toBe("web");
    expect(results[0].provider).toBe("aws");
    expect(results[0].region).toBe("us-east-1");
    expect(results[0].source_file).toBe("main.tf");
    expect(results[0].tags).toEqual({ Name: "web-server" });
    expect(results[0].attributes.instance_type).toBe("t3.large");
  });

  it("extracts multiple resource types", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "t3.micro" }],
        },
        aws_s3_bucket: {
          data: [{ bucket: "my-data-bucket" }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(2);
    const types = results.map((r) => r.type);
    expect(types).toContain("aws_instance");
    expect(types).toContain("aws_s3_bucket");
  });

  it("uses the provided defaultRegions", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "t3.micro" }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf", {
      aws: "eu-west-1",
    });
    expect(results[0].region).toBe("eu-west-1");
  });

  // -------------------------------------------------------------------------
  // count / for_each expansion
  // -------------------------------------------------------------------------

  it("expands resources with count meta-argument", () => {
    const hcl = {
      resource: {
        aws_instance: {
          worker: [{ instance_type: "t3.small", count: 3 }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("aws_instance.worker[0]");
    expect(results[1].id).toBe("aws_instance.worker[1]");
    expect(results[2].id).toBe("aws_instance.worker[2]");
  });

  it("expands resources with for_each using an object", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [
            {
              instance_type: "t3.micro",
              for_each: { prod: {}, staging: {} },
            },
          ],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('aws_instance.web["prod"]');
    expect(results[1].id).toBe('aws_instance.web["staging"]');
  });

  it("expands resources with for_each using an array", () => {
    const hcl = {
      resource: {
        aws_instance: {
          server: [
            {
              instance_type: "t3.micro",
              for_each: ["alpha", "beta"],
            },
          ],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('aws_instance.server["alpha"]');
    expect(results[1].id).toBe('aws_instance.server["beta"]');
  });

  it("generates a warning when count cannot be resolved", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "t3.micro", count: "${var.count}" }],
        },
      },
    };

    const warnings: string[] = [];
    const results = extractResources(hcl, {}, "main.tf", {}, warnings);
    expect(results).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("count");
  });

  it("generates a warning when for_each cannot be resolved", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "t3.micro", for_each: "${var.instances}" }],
        },
      },
    };

    const warnings: string[] = [];
    const results = extractResources(hcl, {}, "main.tf", {}, warnings);
    expect(results).toHaveLength(1);
    expect(warnings[0]).toContain("for_each");
  });

  // -------------------------------------------------------------------------
  // Unknown resource types
  // -------------------------------------------------------------------------

  it("skips resources with unknown provider prefixes", () => {
    const hcl = {
      resource: {
        unknown_resource: {
          foo: [{ some_attr: "value" }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(0);
  });

  it("skips unknown resources but still extracts known ones", () => {
    const hcl = {
      resource: {
        custom_widget: {
          foo: [{ name: "w1" }],
        },
        aws_instance: {
          web: [{ instance_type: "t3.micro" }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("aws_instance");
  });

  // -------------------------------------------------------------------------
  // Empty / missing resources
  // -------------------------------------------------------------------------

  it("returns an empty array when resource block is missing", () => {
    const results = extractResources({}, {}, "main.tf");
    expect(results).toEqual([]);
  });

  it("returns an empty array when resource block is not an object", () => {
    const hcl = { resource: "invalid" };
    const results = extractResources(hcl as unknown as Record<string, unknown>, {}, "main.tf");
    expect(results).toEqual([]);
  });

  it("returns an empty array when resource type has no instances", () => {
    const hcl = {
      resource: {
        aws_instance: {},
      },
    };
    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toEqual([]);
  });

  it("skips a resource when blockList is empty", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [],
        },
      },
    };
    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  it("extracts tags from the resource block", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [
            {
              instance_type: "t3.micro",
              tags: { Environment: "prod", Team: "platform" },
            },
          ],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results[0].tags).toEqual({
      Environment: "prod",
      Team: "platform",
    });
  });

  it("returns empty tags when tags block is absent", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "t3.micro" }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results[0].tags).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Variable substitution
  // -------------------------------------------------------------------------

  it("substitutes variables in resource attributes", () => {
    const hcl = {
      resource: {
        aws_instance: {
          web: [{ instance_type: "${var.instance_type}" }],
        },
      },
    };

    const variables = { instance_type: "m5.xlarge" };
    const results = extractResources(hcl, variables, "main.tf");
    expect(results[0].attributes.instance_type).toBe("m5.xlarge");
  });

  // -------------------------------------------------------------------------
  // count = 0
  // -------------------------------------------------------------------------

  it("produces no resources when count is 0", () => {
    const hcl = {
      resource: {
        aws_instance: {
          disabled: [{ instance_type: "t3.micro", count: 0 }],
        },
      },
    };

    const results = extractResources(hcl, {}, "main.tf");
    expect(results).toHaveLength(0);
  });
});
