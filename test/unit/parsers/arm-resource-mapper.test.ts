import { describe, it, expect } from "vitest";
import { mapArmResource } from "../../../src/parsers/bicep/arm-resource-mapper.js";
import type { ArmResource } from "../../../src/parsers/bicep/arm-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resource(
  overrides: Partial<ArmResource> & Pick<ArmResource, "type" | "name">,
): ArmResource {
  return {
    location: "eastus",
    properties: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unsupported
// ---------------------------------------------------------------------------

describe("mapArmResource — unsupported types", () => {
  it("returns null and pushes a warning for an unsupported type", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({ type: "Microsoft.Unknown/thing", name: "x" }),
      "eastus",
      {},
      "main.bicep",
      warnings,
    );
    expect(r).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unsupported ARM resource type");
    expect(warnings[0]).toContain("x");
  });

  it("matches the type map case-insensitively", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({ type: "MICROSOFT.COMPUTE/VIRTUALMACHINES", name: "vm1" }),
      "eastus",
      {},
      "main.bicep",
      warnings,
    );
    expect(r).not.toBeNull();
    expect(r!.type).toBe("azurerm_linux_virtual_machine");
  });
});

// ---------------------------------------------------------------------------
// Core field mapping
// ---------------------------------------------------------------------------

describe("mapArmResource — core field mapping", () => {
  it("populates id / name / provider / region / source_file", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "web-01",
        location: "westeurope",
        tags: { Env: "prod" },
      }),
      "eastus",
      {},
      "templates/main.bicep",
      warnings,
    );
    expect(r!.id).toBe("web-01");
    expect(r!.name).toBe("web-01");
    expect(r!.provider).toBe("azure");
    expect(r!.region).toBe("westeurope");
    expect(r!.source_file).toBe("templates/main.bicep");
    expect(r!.tags).toEqual({ Env: "prod" });
  });

  it("falls back to the passed-in region when location is missing", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({ type: "Microsoft.Compute/virtualMachines", name: "x" }),
      "centralus",
      {},
      "m.bicep",
      warnings,
    );
    // Empty location defaults to "" which is not a string truthy — but
    // resource().location = "eastus" by default. Override via overrides.
    expect(r!.region).toBe("eastus");
  });

  it("uses `region` arg when location is not a resolvable string", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      {
        type: "Microsoft.Compute/virtualMachines",
        name: "y",
        // Non-string location (could happen from a complex expression).
        location: { resolve: "expression" } as unknown as string,
        properties: {},
      },
      "centralus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.region).toBe("centralus");
  });

  it("defaults tags to {} when not provided", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({ type: "Microsoft.Compute/virtualMachines", name: "x" }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.tags).toEqual({});
  });

  it("handles resources with no properties block", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      {
        type: "Microsoft.Storage/storageAccounts",
        name: "sa1",
        location: "eastus",
      },
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.type).toBe("azurerm_storage_account");
  });
});

// ---------------------------------------------------------------------------
// Parameter resolution
// ---------------------------------------------------------------------------

describe("mapArmResource — parameter resolution", () => {
  it("resolves [parameters('name')] references in location", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        location: "[parameters('region')]",
      }),
      "eastus",
      { region: "northcentralus" },
      "m.bicep",
      warnings,
    );
    expect(r!.region).toBe("northcentralus");
  });

  it("keeps the expression verbatim when the parameter is not defined", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        location: "[parameters('missing')]",
      }),
      "centralus",
      {},
      "m.bicep",
      warnings,
    );
    // resolveParam returns the original string; effectiveRegion then uses it.
    expect(r!.region).toBe("[parameters('missing')]");
  });

  it("resolves [parameters('name')] references inside vmSize", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        properties: {
          hardwareProfile: { vmSize: "[parameters('size')]" },
        },
      }),
      "eastus",
      { size: "Standard_D4s_v5" },
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.vm_size).toBe("Standard_D4s_v5");
  });

  it("leaves vm_size undefined when the parameter is missing and resolveParam returns the literal", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        properties: {
          hardwareProfile: { vmSize: "[parameters('size')]" },
        },
      }),
      "eastus",
      {}, // no size param
      "m.bicep",
      warnings,
    );
    // resolveParam returns the original string → vmSize is still a string;
    // the "typeof === 'string'" check keeps it, so vm_size is the literal.
    expect(r!.attributes.vm_size).toBe("[parameters('size')]");
  });

  it("resolves a parameter reference that points to a non-string value", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        properties: {
          hardwareProfile: { vmSize: "[parameters('count')]" },
        },
      }),
      "eastus",
      { count: 42 }, // resolves to number, not string
      "m.bicep",
      warnings,
    );
    // Since the resolved value isn't a string, vm_size stays undefined.
    expect(r!.attributes.vm_size).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Attribute extraction per resource type
// ---------------------------------------------------------------------------

describe("mapArmResource — attribute extraction", () => {
  it("extracts vm_size from hardwareProfile", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
        properties: { hardwareProfile: { vmSize: "Standard_D2s_v5" } },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.vm_size).toBe("Standard_D2s_v5");
  });

  it("leaves vm_size undefined when hardwareProfile is absent", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({ type: "Microsoft.Compute/virtualMachines", name: "vm" }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.vm_size).toBeUndefined();
  });

  it("extracts disk sku + diskSizeGB", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/disks",
        name: "d1",
        sku: { name: "Premium_LRS" },
        properties: { diskSizeGB: 128 },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Premium_LRS");
    expect(r!.attributes.storage_size_gb).toBe(128);
  });

  it("coerces a string diskSizeGB to a number", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/disks",
        name: "d1",
        properties: { diskSizeGB: "256" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.storage_size_gb).toBe(256);
  });

  it("drops diskSizeGB when it's a non-numeric string", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Compute/disks",
        name: "d1",
        properties: { diskSizeGB: "eight hundred" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.storage_size_gb).toBeUndefined();
  });

  it("extracts postgres flexible server sku + storageSizeGB", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.DBforPostgreSQL/flexibleServers",
        name: "pg",
        sku: { name: "Standard_D2s_v3" },
        properties: { storage: { storageSizeGB: 256 } },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Standard_D2s_v3");
    expect(r!.attributes.storage_size_gb).toBe(256);
  });

  it("extracts mysql flexible server sku", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.DBforMySQL/flexibleServers",
        name: "mysql",
        sku: { name: "Standard_B2s" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Standard_B2s");
  });

  it("extracts storage account sku + kind", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Storage/storageAccounts",
        name: "sa",
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Standard_LRS");
    expect(r!.attributes.kind).toBe("StorageV2");
  });

  it("extracts load-balancer sku", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Network/loadBalancers",
        name: "lb",
        sku: { name: "Standard" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Standard");
  });

  it("extracts AKS node_count + vm_size from agentPoolProfiles[0]", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.ContainerService/managedClusters",
        name: "aks",
        properties: {
          agentPoolProfiles: [
            { count: 3, vmSize: "Standard_D4s_v5" },
            { count: 5, vmSize: "Standard_D8s_v5" },
          ],
        },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.node_count).toBe(3);
    expect(r!.attributes.vm_size).toBe("Standard_D4s_v5");
  });

  it("AKS with no agentPoolProfiles yields undefined node_count + vm_size", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.ContainerService/managedClusters",
        name: "aks",
        properties: {},
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.node_count).toBeUndefined();
    expect(r!.attributes.vm_size).toBeUndefined();
  });

  it("extracts serverfarm sku + tier", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Web/serverfarms",
        name: "plan",
        sku: { name: "P1v3", tier: "PremiumV3" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("P1v3");
    expect(r!.attributes.tier).toBe("PremiumV3");
  });

  it("extracts web site kind", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.Web/sites",
        name: "fn",
        kind: "functionapp",
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.kind).toBe("functionapp");
  });

  it("extracts Key Vault sku", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.KeyVault/vaults",
        name: "kv",
        sku: { name: "premium" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("premium");
  });

  it("extracts container registry sku", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.ContainerRegistry/registries",
        name: "acr",
        sku: { name: "Premium" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.sku).toBe("Premium");
  });

  it("extracts cosmosdb kind + databaseAccountOfferType", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.DocumentDB/databaseAccounts",
        name: "cosmos",
        kind: "MongoDB",
        properties: { databaseAccountOfferType: "Standard" },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.kind).toBe("MongoDB");
    expect(r!.attributes.database_account_offer_type).toBe("Standard");
  });

  it("drops databaseAccountOfferType when it's not a string", () => {
    const warnings: string[] = [];
    const r = mapArmResource(
      resource({
        type: "Microsoft.DocumentDB/databaseAccounts",
        name: "cosmos",
        properties: { databaseAccountOfferType: 42 },
      }),
      "eastus",
      {},
      "m.bicep",
      warnings,
    );
    expect(r!.attributes.database_account_offer_type).toBeUndefined();
  });

  it.each([
    ["Microsoft.SQL/servers", "azurerm_mssql_database"],
    ["Microsoft.Network/natGateways", "azurerm_nat_gateway"],
    ["Microsoft.Network/dnsZones", "azurerm_dns_zone"],
  ])("maps %s to %s with empty attributes", (arm, internal) => {
    const warnings: string[] = [];
    const r = mapArmResource(resource({ type: arm, name: "r" }), "eastus", {}, "m.bicep", warnings);
    expect(r!.type).toBe(internal);
    expect(r!.attributes).toEqual({});
  });
});
