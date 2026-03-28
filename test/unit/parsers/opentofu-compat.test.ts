import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { readdirSync } from "node:fs";
import { parseTerraform } from "../../../src/parsers/index.js";
import { parseHclToJson } from "../../../src/parsers/hcl-parser.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(process.cwd(), "test/fixtures");

function readFixture(fixture: string, filename: string): string {
  return readFileSync(join(FIXTURES, fixture, filename), "utf-8");
}

function opentofuBasicFiles() {
  return [
    { path: "main.tofu", content: readFixture("opentofu-basic", "main.tofu") },
    { path: "variables.tofu", content: readFixture("opentofu-basic", "variables.tofu") },
  ];
}

function opentofuMixedFiles() {
  const dir = join(FIXTURES, "opentofu-mixed");
  const entries = readdirSync(dir);
  return entries
    .filter((e) => extname(e) === ".tf" || extname(e) === ".tofu")
    .map((e) => ({
      path: join(dir, e),
      content: readFileSync(join(dir, e), "utf-8"),
    }));
}

// ---------------------------------------------------------------------------
// .tofu file parsing — raw HCL parser
// ---------------------------------------------------------------------------

describe("parseHclToJson – .tofu extension", () => {
  it("parses a .tofu file and returns a valid object", async () => {
    const hcl = readFixture("opentofu-basic", "main.tofu");
    const json = await parseHclToJson(hcl, "main.tofu");

    expect(typeof json).toBe("object");
    expect(json).not.toBeNull();
    expect(json["resource"]).toBeDefined();
    expect(json["provider"]).toBeDefined();
  });

  it("produces the same structure for identical content regardless of extension", async () => {
    // The .tofu fixture intentionally mirrors the simple-ec2 .tf fixture so we
    // can confirm the parser produces an identical JSON shape for both.
    const tfContent = readFixture("simple-ec2", "main.tf");
    const tofuContent = readFixture("opentofu-basic", "main.tofu");

    // Both declare two aws_instance resources with the same types/names.
    const tfJson = await parseHclToJson(tfContent, "main.tf");
    const tofuJson = await parseHclToJson(tofuContent, "main.tofu");

    const tfResources = (tfJson["resource"] as Record<string, unknown>)["aws_instance"] as Record<
      string,
      unknown
    >;
    const tofuResources = (tofuJson["resource"] as Record<string, unknown>)[
      "aws_instance"
    ] as Record<string, unknown>;

    expect(Object.keys(tofuResources).sort()).toEqual(Object.keys(tfResources).sort());
  });

  it("includes the .tofu filename in parse error messages", async () => {
    await expect(parseHclToJson("resource {{{ not valid hcl !!!", "broken.tofu")).rejects.toThrow(
      /broken\.tofu/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseTerraform with .tofu files
// ---------------------------------------------------------------------------

describe("parseTerraform – opentofu-basic fixture (.tofu files only)", () => {
  it("extracts exactly 2 aws_instance resources from .tofu files", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    const instances = inventory.resources.filter((r) => r.type === "aws_instance");
    expect(instances).toHaveLength(2);
  });

  it("resolves instance_type variable from variables.tofu", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.attributes.instance_type).toBe("t3.micro");
  });

  it("detects provider as aws", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    expect(inventory.provider).toBe("aws");
  });

  it("detects region from provider block (us-west-2)", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    expect(inventory.region).toBe("us-west-2");
    for (const resource of inventory.resources) {
      expect(resource.region).toBe("us-west-2");
    }
  });

  it("extracts storage attributes from root_block_device in .tofu file", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.attributes.storage_size_gb).toBe(20);
    expect(web?.attributes.storage_type).toBe("gp3");
  });

  it("extracts tags from .tofu file resources", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    const web = inventory.resources.find((r) => r.name === "web");
    expect(web?.tags["Name"]).toBe("web-server");
    expect(web?.tags["Environment"]).toBe("production");
  });

  it("sets source_file to the .tofu path for each resource", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    const webInstance = inventory.resources.find((r) => r.name === "web");
    expect(webInstance?.source_file).toBe("main.tofu");
  });

  it("populates total_count and by_type correctly", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    expect(inventory.total_count).toBe(2);
    expect(inventory.by_type["aws_instance"]).toBe(2);
  });

  it("has no parse warnings for valid .tofu fixtures", async () => {
    const inventory = await parseTerraform(opentofuBasicFiles());
    expect(inventory.parse_warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseTerraform with mixed .tf and .tofu files
// ---------------------------------------------------------------------------

describe("parseTerraform – opentofu-mixed fixture (.tofu + .tf files)", () => {
  it("picks up resources from both .tf and .tofu files", async () => {
    const inventory = await parseTerraform(opentofuMixedFiles());
    const types = new Set(inventory.resources.map((r) => r.type));

    expect(types.has("aws_instance")).toBe(true);
    expect(types.has("aws_db_instance")).toBe(true);
  });

  it("extracts instance from the .tofu file correctly", async () => {
    const inventory = await parseTerraform(opentofuMixedFiles());
    const app = inventory.resources.find((r) => r.type === "aws_instance" && r.name === "app");
    expect(app?.attributes.instance_type).toBe("t3.large");
  });

  it("extracts database from the .tf file correctly", async () => {
    const inventory = await parseTerraform(opentofuMixedFiles());
    const db = inventory.resources.find((r) => r.type === "aws_db_instance");
    expect(db?.attributes.engine).toBe("postgres");
    expect(db?.attributes.storage_size_gb).toBe(50);
    expect(db?.attributes.multi_az).toBe(true);
  });

  it("reports the correct total_count across mixed file types", async () => {
    const inventory = await parseTerraform(opentofuMixedFiles());
    expect(inventory.total_count).toBe(2);
  });

  it("has no parse warnings for valid mixed fixtures", async () => {
    const inventory = await parseTerraform(opentofuMixedFiles());
    expect(inventory.parse_warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLI file discovery — extension filtering logic
// ---------------------------------------------------------------------------

describe("CLI file discovery – .tofu extension support", () => {
  it("includes .tofu files when filtering directory entries by extension", () => {
    // Replicate the filter logic from src/cli.ts to confirm both extensions pass.
    const entries = [
      "main.tf",
      "variables.tofu",
      "outputs.tf",
      "main.tofu",
      "README.md",
      "config.json",
    ];
    const filtered = entries.filter((e) => extname(e) === ".tf" || extname(e) === ".tofu");

    expect(filtered).toContain("main.tf");
    expect(filtered).toContain("variables.tofu");
    expect(filtered).toContain("outputs.tf");
    expect(filtered).toContain("main.tofu");
    expect(filtered).not.toContain("README.md");
    expect(filtered).not.toContain("config.json");
  });

  it("excludes unrelated extensions even when they contain tf or tofu as a substring", () => {
    const entries = ["nottofu.ts", "terraform.tfvars", "main.tofu.bak", "main.tofu"];
    const filtered = entries.filter((e) => extname(e) === ".tf" || extname(e) === ".tofu");

    expect(filtered).toEqual(["main.tofu"]);
  });

  it("a directory with only .tofu files passes the filter", () => {
    const entries = ["main.tofu", "variables.tofu", "outputs.tofu"];
    const filtered = entries.filter((e) => extname(e) === ".tf" || extname(e) === ".tofu");

    expect(filtered).toHaveLength(3);
    expect(filtered.every((e) => extname(e) === ".tofu")).toBe(true);
  });
});
