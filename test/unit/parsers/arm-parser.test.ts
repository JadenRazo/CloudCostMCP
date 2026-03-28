import { describe, it, expect } from "vitest";
import { ArmParser } from "../../../src/parsers/bicep/arm-parser.js";
import { detectFormat } from "../../../src/parsers/format-detector.js";

const parser = new ArmParser();

// ---------------------------------------------------------------------------
// Fixture templates
// ---------------------------------------------------------------------------

const SIMPLE_VM_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    vmSize: {
      type: "string",
      defaultValue: "Standard_D2s_v5",
    },
    location: {
      type: "string",
      defaultValue: "westeurope",
    },
  },
  resources: [
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: "2023-03-01",
      name: "myVM",
      location: "[parameters('location')]",
      properties: {
        hardwareProfile: {
          vmSize: "[parameters('vmSize')]",
        },
      },
      tags: {
        environment: "production",
        team: "platform",
      },
    },
  ],
});

const MULTI_RESOURCE_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    location: {
      type: "string",
      defaultValue: "eastus",
    },
  },
  resources: [
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: "2023-03-01",
      name: "webServer",
      location: "[parameters('location')]",
      properties: {
        hardwareProfile: {
          vmSize: "Standard_B2ms",
        },
      },
    },
    {
      type: "Microsoft.Compute/disks",
      apiVersion: "2023-04-02",
      name: "dataDisk",
      location: "[parameters('location')]",
      sku: { name: "Premium_LRS" },
      properties: {
        diskSizeGB: 256,
      },
    },
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-01-01",
      name: "mystorage",
      location: "[parameters('location')]",
      kind: "StorageV2",
      sku: { name: "Standard_LRS" },
      properties: {},
    },
  ],
});

const PARAM_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    vmSize: {
      type: "string",
      defaultValue: "Standard_D2s_v5",
    },
    environment: {
      type: "string",
      // No default
    },
    location: {
      type: "string",
      defaultValue: "northeurope",
    },
  },
  resources: [
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: "2023-03-01",
      name: "vm1",
      location: "[parameters('location')]",
      properties: {
        hardwareProfile: {
          vmSize: "[parameters('vmSize')]",
        },
      },
    },
  ],
});

const AKS_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.ContainerService/managedClusters",
      apiVersion: "2023-06-01",
      name: "myAKS",
      location: "westus2",
      properties: {
        agentPoolProfiles: [
          {
            name: "nodepool1",
            count: 3,
            vmSize: "Standard_D4s_v5",
          },
        ],
      },
    },
  ],
});

const DATABASE_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.DBforPostgreSQL/flexibleServers",
      apiVersion: "2023-03-01-preview",
      name: "myPostgres",
      location: "eastus2",
      sku: { name: "Standard_D4s_v3", tier: "GeneralPurpose" },
      properties: {
        storage: {
          storageSizeGB: 128,
        },
      },
    },
    {
      type: "Microsoft.DBforMySQL/flexibleServers",
      apiVersion: "2023-06-01-preview",
      name: "myMySQL",
      location: "eastus2",
      sku: { name: "Standard_B1ms", tier: "Burstable" },
      properties: {},
    },
  ],
});

const UNSUPPORTED_RESOURCE_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-01-01",
      name: "myStorage",
      location: "eastus",
      kind: "StorageV2",
      sku: { name: "Standard_LRS" },
      properties: {},
    },
    {
      type: "Microsoft.Insights/activityLogAlerts",
      apiVersion: "2020-10-01",
      name: "myAlert",
      location: "global",
      properties: {},
    },
  ],
});

const EMPTY_RESOURCES_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [],
});

const CFN_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: {
      Type: "AWS::S3::Bucket",
      Properties: {},
    },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ArmParser", () => {
  describe("detect", () => {
    it("detects a JSON template with Azure schema URL", () => {
      const files = [{ path: "deploy.json", content: SIMPLE_VM_TEMPLATE }];
      expect(parser.detect(files)).toBe(true);
    });

    it("detects a template with Microsoft. types and apiVersion", () => {
      const content = JSON.stringify({
        resources: [
          {
            type: "Microsoft.Storage/storageAccounts",
            apiVersion: "2023-01-01",
            name: "test",
            properties: {},
          },
        ],
      });
      const files = [{ path: "deploy.json", content }];
      expect(parser.detect(files)).toBe(true);
    });

    it("does not detect a non-ARM JSON file", () => {
      const files = [{ path: "data.json", content: '{"foo": "bar"}' }];
      expect(parser.detect(files)).toBe(false);
    });

    it("does not detect a Terraform file", () => {
      const files = [{ path: "main.tf", content: 'resource "azurerm_resource_group" {}' }];
      expect(parser.detect(files)).toBe(false);
    });

    it("does not detect a YAML file even with Azure content", () => {
      const files = [{ path: "deploy.yaml", content: "schema.management.azure.com" }];
      expect(parser.detect(files)).toBe(false);
    });
  });

  describe("parse - simple VM template", () => {
    it("parses a VM and resolves parameter references", async () => {
      const files = [{ path: "deploy.json", content: SIMPLE_VM_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.provider).toBe("azure");
      expect(result.region).toBe("westeurope");
      expect(result.total_count).toBe(1);
      expect(result.resources).toHaveLength(1);

      const vm = result.resources[0];
      expect(vm.type).toBe("azurerm_linux_virtual_machine");
      expect(vm.id).toBe("myVM");
      expect(vm.name).toBe("myVM");
      expect(vm.provider).toBe("azure");
      expect(vm.attributes.vm_size).toBe("Standard_D2s_v5");
      expect(vm.region).toBe("westeurope");
    });
  });

  describe("parse - multi-resource template", () => {
    it("parses VM + disk + storage", async () => {
      const files = [{ path: "deploy.json", content: MULTI_RESOURCE_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(3);
      expect(result.by_type).toEqual({
        azurerm_linux_virtual_machine: 1,
        azurerm_managed_disk: 1,
        azurerm_storage_account: 1,
      });

      const disk = result.resources.find((r) => r.type === "azurerm_managed_disk");
      expect(disk).toBeDefined();
      expect(disk!.attributes.sku).toBe("Premium_LRS");
      expect(disk!.attributes.storage_size_gb).toBe(256);

      const storage = result.resources.find((r) => r.type === "azurerm_storage_account");
      expect(storage).toBeDefined();
      expect(storage!.attributes.sku).toBe("Standard_LRS");
      expect(storage!.attributes.kind).toBe("StorageV2");
    });
  });

  describe("parse - parameter defaults and overrides", () => {
    it("uses parameter defaults when no overrides provided", async () => {
      const files = [{ path: "deploy.json", content: PARAM_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.region).toBe("northeurope");
      const vm = result.resources[0];
      expect(vm.attributes.vm_size).toBe("Standard_D2s_v5");
    });

    it("warns about parameters with no default and no override", async () => {
      const files = [{ path: "deploy.json", content: PARAM_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.parse_warnings).toContain(
        "Parameter 'environment' has no default value and no override provided",
      );
    });

    it("applies parameter overrides from JSON string", async () => {
      const files = [{ path: "deploy.json", content: PARAM_TEMPLATE }];
      const overrides = JSON.stringify({
        vmSize: "Standard_E4s_v5",
        environment: "staging",
        location: "uksouth",
      });
      const result = await parser.parse(files, { variableOverrides: overrides });

      expect(result.region).toBe("uksouth");
      expect(result.parse_warnings.some((w) => w.includes("environment"))).toBe(false);

      const vm = result.resources[0];
      expect(vm.attributes.vm_size).toBe("Standard_E4s_v5");
    });
  });

  describe("parse - parameter reference resolution", () => {
    it("resolves [parameters('name')] references in properties", async () => {
      const files = [{ path: "deploy.json", content: SIMPLE_VM_TEMPLATE }];
      const result = await parser.parse(files);

      const vm = result.resources[0];
      // vmSize was [parameters('vmSize')] which resolves to the default "Standard_D2s_v5"
      expect(vm.attributes.vm_size).toBe("Standard_D2s_v5");
      // location was [parameters('location')] which resolves to "westeurope"
      expect(vm.region).toBe("westeurope");
    });
  });

  describe("parse - unsupported resource types", () => {
    it("generates warnings for unsupported types and still parses supported ones", async () => {
      const files = [{ path: "deploy.json", content: UNSUPPORTED_RESOURCE_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(1);
      expect(result.resources[0].type).toBe("azurerm_storage_account");
      expect(result.parse_warnings).toContainEqual(
        expect.stringContaining("Microsoft.Insights/activityLogAlerts"),
      );
    });
  });

  describe("parse - AKS cluster with agent pool", () => {
    it("extracts node count and VM size from agent pool profiles", async () => {
      const files = [{ path: "deploy.json", content: AKS_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(1);
      const aks = result.resources[0];
      expect(aks.type).toBe("azurerm_kubernetes_cluster");
      expect(aks.attributes.node_count).toBe(3);
      expect(aks.attributes.vm_size).toBe("Standard_D4s_v5");
      expect(aks.region).toBe("westus2");
    });
  });

  describe("parse - database resources", () => {
    it("parses PostgreSQL and MySQL flexible servers", async () => {
      const files = [{ path: "deploy.json", content: DATABASE_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(2);

      const pg = result.resources.find((r) => r.type === "azurerm_postgresql_flexible_server");
      expect(pg).toBeDefined();
      expect(pg!.attributes.sku).toBe("Standard_D4s_v3");
      expect(pg!.attributes.storage_size_gb).toBe(128);

      const mysql = result.resources.find((r) => r.type === "azurerm_mysql_flexible_server");
      expect(mysql).toBeDefined();
      expect(mysql!.attributes.sku).toBe("Standard_B1ms");
    });
  });

  describe("parse - empty resources", () => {
    it("returns an empty inventory with no warnings", async () => {
      const files = [{ path: "deploy.json", content: EMPTY_RESOURCES_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.resources).toEqual([]);
      expect(result.provider).toBe("azure");
    });
  });

  describe("parse - invalid JSON", () => {
    it("returns warnings for unparseable content", async () => {
      const files = [{ path: "deploy.json", content: "not valid json {{{" }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.parse_warnings.length).toBeGreaterThan(0);
    });

    it("returns warnings for JSON missing resources array", async () => {
      const files = [{ path: "deploy.json", content: '{"description": "no resources"}' }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.parse_warnings).toContainEqual(
        expect.stringContaining("missing resources array"),
      );
    });
  });

  describe("parse - tags extraction", () => {
    it("extracts tags from resources", async () => {
      const files = [{ path: "deploy.json", content: SIMPLE_VM_TEMPLATE }];
      const result = await parser.parse(files);

      const vm = result.resources[0];
      expect(vm.tags).toEqual({
        environment: "production",
        team: "platform",
      });
    });
  });

  describe("format detector integration", () => {
    it("auto-detects ARM template via detectFormat", () => {
      const files = [{ path: "deploy.json", content: SIMPLE_VM_TEMPLATE }];
      const detected = detectFormat(files);
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe("ARM");
    });

    it("does not conflict with CloudFormation detection", () => {
      const files = [{ path: "stack.json", content: CFN_TEMPLATE }];
      const detected = detectFormat(files);
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe("CloudFormation");
    });

    it("prefers Terraform for .tf files", () => {
      const files = [{ path: "main.tf", content: 'resource "azurerm_resource_group" "rg" {}' }];
      const detected = detectFormat(files);
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe("Terraform");
    });
  });
});
