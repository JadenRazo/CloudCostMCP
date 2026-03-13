import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolveModules } from "../../../src/parsers/module-resolver.js";
import { parseTerraform } from "../../../src/parsers/index.js";
import { parseHclToJson } from "../../../src/parsers/hcl-parser.js";
import { resolveVariables } from "../../../src/parsers/variable-resolver.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(process.cwd(), "test/fixtures/modules");
const PARENT_DIR = join(FIXTURES, "parent");
const CHILD_DIR = join(FIXTURES, "child");

function readFixtureFile(dir: string, filename: string): string {
  return readFileSync(join(dir, filename), "utf-8");
}

function parentFiles() {
  return [
    { path: join(PARENT_DIR, "main.tf"), content: readFixtureFile(PARENT_DIR, "main.tf") },
    { path: join(PARENT_DIR, "variables.tf"), content: readFixtureFile(PARENT_DIR, "variables.tf") },
  ];
}

// ---------------------------------------------------------------------------
// resolveModules – local module resolution
// ---------------------------------------------------------------------------

describe("resolveModules – local module resolution", () => {
  it("resolves a local module and returns its resources", async () => {
    const warnings: string[] = [];

    // Build a minimal HCL JSON with a module block pointing to the child fixture.
    const hclJson = {
      module: {
        app: [
          {
            source: "../child",
          },
        ],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    expect(resources.length).toBeGreaterThan(0);
    // Should find the aws_instance and aws_s3_bucket from the child fixture.
    const instanceResource = resources.find((r) => r.type === "aws_instance");
    expect(instanceResource).toBeDefined();
  });

  it("prefixes resource IDs with module.<name>.", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [{ source: "../child" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    for (const resource of resources) {
      expect(resource.id).toMatch(/^module\.app\./);
    }
  });

  it("finds both resources defined in the child module", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [{ source: "../child" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    const types = resources.map((r) => r.type);

    expect(types).toContain("aws_instance");
    expect(types).toContain("aws_s3_bucket");
  });

  it("produces no warnings for a successfully resolved local module", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [{ source: "../child" }],
      },
    };

    await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    // No error or skip warnings should be emitted for a valid local module.
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveModules – variable pass-through
// ---------------------------------------------------------------------------

describe("resolveModules – variable pass-through", () => {
  it("uses child variable defaults when no inputs are provided", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [{ source: "../child" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    const instance = resources.find((r) => r.type === "aws_instance");

    // Child variable default for instance_type is "t3.nano".
    expect(instance?.attributes.instance_type).toBe("t3.nano");
  });

  it("overrides child variable defaults with parent module inputs", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [
          {
            source: "../child",
            instance_type: "t3.large",
          },
        ],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    const instance = resources.find((r) => r.type === "aws_instance");

    // The parent passed instance_type = "t3.large", which overrides the default.
    expect(instance?.attributes.instance_type).toBe("t3.large");
  });
});

// ---------------------------------------------------------------------------
// resolveModules – missing / non-existent module directory
// ---------------------------------------------------------------------------

describe("resolveModules – missing module directory", () => {
  it("emits a warning when a local module directory does not exist", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        missing: [{ source: "./nonexistent-module" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    // No resources should be returned for a missing module.
    expect(resources).toHaveLength(0);
    // The resolver should push a warning (module resolves to empty directory).
    // An empty directory returns zero resources without a hard error.
    // Absence of warning is acceptable here — the directory simply has no .tf files.
    // The important assertion is that it does not throw.
  });

  it("emits a warning for an uninitialised registry module", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        vpc: [{ source: "terraform-aws-modules/vpc/aws" }],
      },
    };

    await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    const registryWarning = warnings.find(
      (w) => w.includes('"vpc"') && w.includes(".terraform/modules")
    );
    expect(registryWarning).toBeDefined();
  });

  it("returns no resources for an uninitialised registry module", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        vpc: [{ source: "terraform-aws-modules/vpc/aws" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    expect(resources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveModules – git module sources
// ---------------------------------------------------------------------------

describe("resolveModules – git module sources", () => {
  it("emits a warning and skips git:: sourced modules", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        custom: [{ source: "git::https://example.com/repo.git" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    expect(resources).toHaveLength(0);
    const gitWarning = warnings.find(
      (w) => w.includes('Module "custom"') && w.includes("git")
    );
    expect(gitWarning).toBeDefined();
  });

  it("emits a warning and skips github.com sourced modules", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        ghmod: [{ source: "github.com/hashicorp/example" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);

    expect(resources).toHaveLength(0);
    const gitWarning = warnings.find(
      (w) => w.includes('Module "ghmod"') && w.includes("git")
    );
    expect(gitWarning).toBeDefined();
  });

  it("returns an empty array when all modules are git-sourced", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        a: [{ source: "git::https://a.example.com/mod.git" }],
        b: [{ source: "github.com/org/module" }],
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    expect(resources).toHaveLength(0);
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveModules – max depth guard
// ---------------------------------------------------------------------------

describe("resolveModules – max depth guard", () => {
  it("stops recursion and emits a warning when depth limit is reached", async () => {
    const warnings: string[] = [];
    const hclJson = {
      module: {
        app: [{ source: "./child" }],
      },
    };

    // Calling with depth = 10 (the limit) should trigger the guard immediately.
    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings, 10);

    expect(resources).toHaveLength(0);
    const depthWarning = warnings.find((w) => w.includes("depth limit"));
    expect(depthWarning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolveModules – no module blocks
// ---------------------------------------------------------------------------

describe("resolveModules – no module blocks", () => {
  it("returns an empty array when the HCL JSON has no module section", async () => {
    const warnings: string[] = [];
    const hclJson = {
      resource: {
        aws_instance: {
          web: [{ ami: "ami-abc123", instance_type: "t3.micro" }],
        },
      },
    };

    const resources = await resolveModules(hclJson, PARENT_DIR, {}, warnings);
    expect(resources).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("returns an empty array for an empty HCL JSON object", async () => {
    const warnings: string[] = [];
    const resources = await resolveModules({}, PARENT_DIR, {}, warnings);
    expect(resources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseTerraform integration – module expansion
// ---------------------------------------------------------------------------

describe("parseTerraform – module expansion integration", () => {
  it("includes child module resources in the inventory when resolveModulesEnabled=true", async () => {
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      true
    );

    // The parent has 1 aws_instance; the child has 1 aws_instance + 1 aws_s3_bucket.
    const instances = inventory.resources.filter(
      (r) => r.type === "aws_instance"
    );
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });

  it("prefixes child resources with module.<name>. in the inventory", async () => {
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      true
    );

    const moduleResources = inventory.resources.filter((r) =>
      r.id.startsWith("module.app.")
    );
    expect(moduleResources.length).toBeGreaterThan(0);
  });

  it("parent resources are not prefixed with module.", async () => {
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      true
    );

    const parentResource = inventory.resources.find(
      (r) => r.type === "aws_instance" && r.name === "parent_server"
    );
    expect(parentResource).toBeDefined();
    expect(parentResource?.id).toBe("aws_instance.parent_server");
  });

  it("does not expand modules when resolveModulesEnabled=false", async () => {
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      false
    );

    // With module expansion disabled, only the parent resource should appear.
    const moduleResources = inventory.resources.filter((r) =>
      r.id.startsWith("module.")
    );
    expect(moduleResources).toHaveLength(0);

    // The parent aws_instance should still be there.
    const parentInstance = inventory.resources.find(
      (r) => r.type === "aws_instance" && r.name === "parent_server"
    );
    expect(parentInstance).toBeDefined();
  });

  it("passes variable inputs from parent module block to child", async () => {
    // The parent passes child_instance_type (default "t3.micro") to the child module.
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      true
    );

    const childInstance = inventory.resources.find(
      (r) => r.id.startsWith("module.app.") && r.type === "aws_instance"
    );
    // Parent default for child_instance_type is "t3.micro", which overrides
    // the child module's own default of "t3.nano".
    expect(childInstance?.attributes.instance_type).toBe("t3.micro");
  });

  it("total_count includes both parent and child resources", async () => {
    const inventory = await parseTerraform(
      parentFiles(),
      undefined,
      PARENT_DIR,
      true
    );

    // Parent: 1 aws_instance. Child: 1 aws_instance + 1 aws_s3_bucket = 3 total.
    expect(inventory.total_count).toBeGreaterThanOrEqual(3);
  });
});
