import { describe, it, expect } from "vitest";
import { resolveVariables, substituteVariables } from "../../../src/parsers/variable-resolver.js";

// ---------------------------------------------------------------------------
// resolveVariables
// ---------------------------------------------------------------------------

describe("resolveVariables", () => {
  it("extracts defaults from HCL variable blocks", () => {
    const hcl = {
      variable: {
        region: [{ default: "us-east-1", type: "string" }],
        instance_type: [{ default: "t3.micro", type: "string" }],
      },
    };

    const result = resolveVariables(hcl);
    expect(result).toEqual({
      region: "us-east-1",
      instance_type: "t3.micro",
    });
  });

  it("skips variables without a default value", () => {
    const hcl = {
      variable: {
        region: [{ default: "us-east-1" }],
        ami_id: [{ type: "string", description: "AMI to use" }],
      },
    };

    const result = resolveVariables(hcl);
    expect(result).toEqual({ region: "us-east-1" });
    expect(result).not.toHaveProperty("ami_id");
  });

  it("returns empty object when no variable block is present", () => {
    expect(resolveVariables({})).toEqual({});
  });

  it("returns empty object when variable block is not an object", () => {
    expect(resolveVariables({ variable: "bogus" })).toEqual({});
  });

  // -------------------------------------------------------------------------
  // tfvars overrides
  // -------------------------------------------------------------------------

  it("applies tfvars overrides on top of defaults", () => {
    const hcl = {
      variable: {
        region: [{ default: "us-east-1" }],
        instance_type: [{ default: "t3.micro" }],
      },
    };

    const tfvars = `region = "eu-west-1"\n`;
    const result = resolveVariables(hcl, tfvars);

    expect(result.region).toBe("eu-west-1");
    expect(result.instance_type).toBe("t3.micro");
  });

  it("tfvars can introduce variables not present in defaults", () => {
    const hcl = { variable: {} };
    const tfvars = `extra_tag = "hello"\n`;
    const result = resolveVariables(hcl, tfvars);

    expect(result.extra_tag).toBe("hello");
  });

  it("parses numeric, boolean, and null tfvars values", () => {
    const tfvars = [
      "count = 3",
      "enabled = true",
      "disabled = false",
      "nothing = null",
      "ratio = 1.5",
    ].join("\n");

    const result = resolveVariables({}, tfvars);
    expect(result.count).toBe(3);
    expect(result.enabled).toBe(true);
    expect(result.disabled).toBe(false);
    expect(result.nothing).toBeNull();
    expect(result.ratio).toBe(1.5);
  });

  it("ignores comments and blank lines in tfvars", () => {
    const tfvars = `# This is a comment\n\nregion = "us-west-2"\n# another comment`;
    const result = resolveVariables({}, tfvars);

    expect(result).toEqual({ region: "us-west-2" });
  });
});

// ---------------------------------------------------------------------------
// substituteVariables
// ---------------------------------------------------------------------------

describe("substituteVariables", () => {
  it("substitutes a whole-string variable reference", () => {
    const result = substituteVariables("${var.region}", { region: "us-east-1" });
    expect(result).toBe("us-east-1");
  });

  it("preserves non-string type for whole-string references", () => {
    const result = substituteVariables("${var.count}", { count: 3 });
    expect(result).toBe(3);
  });

  it("substitutes inline variable references within a string", () => {
    const result = substituteVariables("arn:aws:s3:::${var.bucket_name}/path", {
      bucket_name: "my-bucket",
    });
    expect(result).toBe("arn:aws:s3:::my-bucket/path");
  });

  it("handles multiple inline references in one string", () => {
    const result = substituteVariables("${var.prefix}-${var.env}-resource", {
      prefix: "app",
      env: "prod",
    });
    expect(result).toBe("app-prod-resource");
  });

  it("leaves unresolved whole-string variable references as-is", () => {
    const result = substituteVariables("${var.missing}", {});
    expect(result).toBe("${var.missing}");
  });

  it("leaves unresolved inline variable references as-is", () => {
    const result = substituteVariables("prefix-${var.missing}-suffix", {});
    expect(result).toBe("prefix-${var.missing}-suffix");
  });

  it("recursively substitutes within arrays", () => {
    const result = substituteVariables(["${var.a}", "${var.b}"], { a: "alpha", b: "beta" });
    expect(result).toEqual(["alpha", "beta"]);
  });

  it("recursively substitutes within nested objects", () => {
    const result = substituteVariables({ tags: { Name: "${var.name}" } }, { name: "my-instance" });
    expect(result).toEqual({ tags: { Name: "my-instance" } });
  });

  it("passes through non-string primitives unchanged", () => {
    expect(substituteVariables(42, {})).toBe(42);
    expect(substituteVariables(true, {})).toBe(true);
    expect(substituteVariables(null, {})).toBeNull();
  });

  it("converts null variable value to empty string in inline context", () => {
    const result = substituteVariables("prefix-${var.x}-suffix", { x: null });
    expect(result).toBe("prefix--suffix");
  });
});
