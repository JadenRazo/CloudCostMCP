import { describe, it, expect } from "vitest";
import { analyzeTerraform } from "../../../src/tools/analyze-terraform.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}
`;

const MULTI_RESOURCE_TF = `
provider "aws" {
  region = "us-west-2"
}

resource "aws_instance" "app" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.small"

  tags = {
    Environment = "production"
  }
}

resource "aws_db_instance" "main" {
  identifier        = "main-db"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.t3.medium"
  allocated_storage = 100
  storage_type      = "gp3"
}

resource "aws_s3_bucket" "assets" {
  bucket = "my-app-assets"
}
`;

const AZURE_TF = `
provider "azurerm" {
  features {}
}

resource "azurerm_linux_virtual_machine" "web" {
  name                = "web-vm"
  resource_group_name = "my-rg"
  location            = "eastus"
  size                = "Standard_D2s_v3"

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "UbuntuServer"
    sku       = "18.04-LTS"
    version   = "latest"
  }
}
`;

const DEPENDENCY_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.public.id

  depends_on = [aws_vpc.main]
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("analyzeTerraform", () => {
  // -------------------------------------------------------------------------
  // Happy path — basic resource extraction
  // -------------------------------------------------------------------------

  it("returns resources array for a single-instance config", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
      include_dependencies: false,
    }) as Record<string, unknown>;

    expect(Array.isArray(result.resources)).toBe(true);
    const resources = result.resources as Array<Record<string, unknown>>;
    expect(resources.length).toBeGreaterThanOrEqual(1);

    const instance = resources.find((r) => r.type === "aws_instance");
    expect(instance).toBeDefined();
    expect(instance!.name).toBe("web");
  });

  it("extracts provider and region from a basic config", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
    }) as Record<string, unknown>;

    expect(result.provider).toBe("aws");
    expect(result.region).toBe("us-east-1");
  });

  it("extracts multiple resource types from a full-stack config", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
    }) as Record<string, unknown>;

    const resources = result.resources as Array<Record<string, unknown>>;
    const types = resources.map((r) => r.type);

    expect(types).toContain("aws_instance");
    expect(types).toContain("aws_db_instance");
    expect(types).toContain("aws_s3_bucket");
  });

  it("resource entries contain required fields", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
    }) as Record<string, unknown>;

    const resources = result.resources as Array<Record<string, unknown>>;
    expect(resources.length).toBeGreaterThan(0);

    for (const r of resources) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.type).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.provider).toBe("string");
    }
  });

  it("parse_warnings appears at the top level", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
    }) as Record<string, unknown>;

    // parse_warnings is always present — may be an empty array for clean HCL.
    expect(result).toHaveProperty("parse_warnings");
    expect(Array.isArray(result.parse_warnings)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Provider variations
  // -------------------------------------------------------------------------

  it("correctly identifies Azure provider", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: AZURE_TF }],
    }) as Record<string, unknown>;

    expect(result.provider).toBe("azure");
    const resources = result.resources as Array<Record<string, unknown>>;
    const vm = resources.find((r) => r.type === "azurerm_linux_virtual_machine");
    expect(vm).toBeDefined();
    expect(vm!.name).toBe("web");
  });

  it("handles an AWS config and an Azure config with the correct provider each time", async () => {
    const awsResult = await analyzeTerraform({
      files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
    }) as Record<string, unknown>;

    const azureResult = await analyzeTerraform({
      files: [{ path: "main.tf", content: AZURE_TF }],
    }) as Record<string, unknown>;

    expect(awsResult.provider).toBe("aws");
    expect(azureResult.provider).toBe("azure");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("returns empty resources array for a file with no resource blocks", async () => {
    const emptyTf = `
provider "aws" {
  region = "us-east-1"
}
`;
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: emptyTf }],
    }) as Record<string, unknown>;

    const resources = result.resources as Array<Record<string, unknown>>;
    expect(resources.length).toBe(0);
  });

  it("handles multiple files and merges resources from all of them", async () => {
    const file1 = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-abc"
  instance_type = "t3.micro"
}
`;
    const file2 = `
resource "aws_s3_bucket" "assets" {
  bucket = "my-bucket"
}
`;

    const result = await analyzeTerraform({
      files: [
        { path: "compute.tf", content: file1 },
        { path: "storage.tf", content: file2 },
      ],
    }) as Record<string, unknown>;

    const resources = result.resources as Array<Record<string, unknown>>;
    const types = resources.map((r) => r.type);
    expect(types).toContain("aws_instance");
    expect(types).toContain("aws_s3_bucket");
  });

  it("hoists shared source_file to top level when all resources come from one file", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: MULTI_RESOURCE_TF }],
    }) as Record<string, unknown>;

    // When all resources share one source file, the handler hoists it.
    expect(result.source_file).toBe("main.tf");

    // Individual resource objects should not redundantly repeat source_file.
    const resources = result.resources as Array<Record<string, unknown>>;
    for (const r of resources) {
      expect(r).not.toHaveProperty("source_file");
    }
  });

  it("strips empty tags objects from individual resources", async () => {
    // SINGLE_INSTANCE_TF has no tags block — the parser may produce an empty
    // tags object, which the handler is responsible for removing.
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: SINGLE_INSTANCE_TF }],
    }) as Record<string, unknown>;

    const resources = result.resources as Array<Record<string, unknown>>;
    const instance = resources.find((r) => r.type === "aws_instance");
    expect(instance).toBeDefined();

    // Either tags is absent, or it has at least one key.
    if ("tags" in instance!) {
      expect(Object.keys(instance!.tags as object).length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Dependency graph
  // -------------------------------------------------------------------------

  it("includes dependency_graph and mermaid_diagram when include_dependencies is true", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: DEPENDENCY_TF }],
      include_dependencies: true,
    }) as Record<string, unknown>;

    expect(result).toHaveProperty("dependency_graph");
    expect(result).toHaveProperty("mermaid_diagram");
    expect(typeof result.mermaid_diagram).toBe("string");
    // The Mermaid diagram should start with the graph declaration.
    expect((result.mermaid_diagram as string).trim()).toMatch(/^graph\s+/i);
  });

  it("does not include dependency_graph when include_dependencies is false", async () => {
    const result = await analyzeTerraform({
      files: [{ path: "main.tf", content: DEPENDENCY_TF }],
      include_dependencies: false,
    }) as Record<string, unknown>;

    expect(result).not.toHaveProperty("dependency_graph");
    expect(result).not.toHaveProperty("mermaid_diagram");
  });
});
