import { describe, it, expect } from "vitest";
import { azureExtractors } from "../../../src/parsers/extractors/azure-extractor.js";

// ---------------------------------------------------------------------------
// Azure Extractor Tests
// ---------------------------------------------------------------------------

describe("azureExtractors", () => {
  // -----------------------------------------------------------------------
  // azurerm_virtual_machine
  // -----------------------------------------------------------------------
  describe("azurerm_virtual_machine", () => {
    const extract = azureExtractors["azurerm_virtual_machine"];

    it("should extract vm_size and location", () => {
      const block = {
        vm_size: "Standard_D2s_v3",
        location: "eastus",
      };
      const attrs = extract(block);
      expect(attrs.vm_size).toBe("Standard_D2s_v3");
      expect(attrs.location).toBe("eastus");
    });

    it("should handle missing location", () => {
      const block = { vm_size: "Standard_B1s" };
      const attrs = extract(block);
      expect(attrs.vm_size).toBe("Standard_B1s");
      expect(attrs.location).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });

    it("should ignore empty string vm_size", () => {
      const block = { vm_size: "" };
      const attrs = extract(block);
      expect(attrs.vm_size).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_linux_virtual_machine
  // -----------------------------------------------------------------------
  describe("azurerm_linux_virtual_machine", () => {
    const extract = azureExtractors["azurerm_linux_virtual_machine"];

    it("should extract size as vm_size", () => {
      const block = {
        size: "Standard_D4s_v3",
        location: "westeurope",
      };
      const attrs = extract(block);
      expect(attrs.vm_size).toBe("Standard_D4s_v3");
      expect(attrs.location).toBe("westeurope");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_windows_virtual_machine
  // -----------------------------------------------------------------------
  describe("azurerm_windows_virtual_machine", () => {
    const extract = azureExtractors["azurerm_windows_virtual_machine"];

    it("should extract size and always set os to Windows", () => {
      const block = {
        size: "Standard_D2s_v3",
        location: "eastus2",
      };
      const attrs = extract(block);
      expect(attrs.vm_size).toBe("Standard_D2s_v3");
      expect(attrs.location).toBe("eastus2");
      expect(attrs.os).toBe("Windows");
    });

    it("should set os to Windows even for empty block", () => {
      const attrs = extract({});
      expect(attrs.os).toBe("Windows");
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_managed_disk
  // -----------------------------------------------------------------------
  describe("azurerm_managed_disk", () => {
    const extract = azureExtractors["azurerm_managed_disk"];

    it("should extract all disk attributes", () => {
      const block = {
        storage_account_type: "Premium_LRS",
        disk_size_gb: 256,
        disk_iops_read_write: 7500,
        location: "eastus",
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("Premium_LRS");
      expect(attrs.storage_size_gb).toBe(256);
      expect(attrs.iops).toBe(7500);
      expect(attrs.location).toBe("eastus");
    });

    it("should handle Standard_LRS disk", () => {
      const block = {
        storage_account_type: "Standard_LRS",
        disk_size_gb: 128,
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("Standard_LRS");
      expect(attrs.storage_size_gb).toBe(128);
      expect(attrs.iops).toBeUndefined();
    });

    it("should handle zero disk size", () => {
      const block = { disk_size_gb: 0 };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });

    it("should handle string disk_size_gb", () => {
      const block = { disk_size_gb: "512" };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(512);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_sql_server
  // -----------------------------------------------------------------------
  describe("azurerm_sql_server", () => {
    const extract = azureExtractors["azurerm_sql_server"];

    it("should extract version and location", () => {
      const block = { version: "12.0", location: "eastus" };
      const attrs = extract(block);
      expect(attrs.engine_version).toBe("12.0");
      expect(attrs.location).toBe("eastus");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_mssql_database
  // -----------------------------------------------------------------------
  describe("azurerm_mssql_database", () => {
    const extract = azureExtractors["azurerm_mssql_database"];

    it("should extract sku and max size", () => {
      const block = {
        sku_name: "GP_Gen5_2",
        max_size_gb: 32,
      };
      const attrs = extract(block);
      expect(attrs.sku).toBe("GP_Gen5_2");
      expect(attrs.storage_size_gb).toBe(32);
    });

    it("should handle serverless SKU", () => {
      const block = { sku_name: "GP_S_Gen5_2" };
      const attrs = extract(block);
      expect(attrs.sku).toBe("GP_S_Gen5_2");
      expect(attrs.storage_size_gb).toBeUndefined();
    });

    it("should handle zero max_size_gb", () => {
      const block = { max_size_gb: 0 };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_kubernetes_cluster
  // -----------------------------------------------------------------------
  describe("azurerm_kubernetes_cluster", () => {
    const extract = azureExtractors["azurerm_kubernetes_cluster"];

    it("should extract default node pool and location", () => {
      const block = {
        default_node_pool: [
          {
            vm_size: "Standard_D4s_v3",
            node_count: 3,
            min_count: 1,
            max_count: 10,
          },
        ],
        location: "eastus",
      };
      const attrs = extract(block);
      expect(attrs.vm_size).toBe("Standard_D4s_v3");
      expect(attrs.node_count).toBe(3);
      expect(attrs.min_node_count).toBe(1);
      expect(attrs.max_node_count).toBe(10);
      expect(attrs.location).toBe("eastus");
    });

    it("should handle missing default_node_pool", () => {
      const block = { location: "westus2" };
      const attrs = extract(block);
      expect(attrs.vm_size).toBeUndefined();
      expect(attrs.node_count).toBeUndefined();
      expect(attrs.location).toBe("westus2");
    });

    it("should handle empty default_node_pool array", () => {
      const block = { default_node_pool: [] };
      const attrs = extract(block);
      expect(attrs.vm_size).toBeUndefined();
    });

    it("should handle node_count of zero", () => {
      const block = {
        default_node_pool: [{ node_count: 0, min_count: 0, max_count: 5 }],
      };
      const attrs = extract(block);
      expect(attrs.node_count).toBe(0);
      expect(attrs.min_node_count).toBe(0);
    });

    it("should return empty for empty block", () => {
      const attrs = extract({});
      expect(attrs.vm_size).toBeUndefined();
      expect(attrs.location).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_cosmosdb_account
  // -----------------------------------------------------------------------
  describe("azurerm_cosmosdb_account", () => {
    const extract = azureExtractors["azurerm_cosmosdb_account"];

    it("should extract offer type, kind, and capabilities", () => {
      const block = {
        offer_type: "Standard",
        kind: "GlobalDocumentDB",
        capabilities: [{ name: "EnableServerless" }, { name: "EnableTable" }],
      };
      const attrs = extract(block);
      expect(attrs.offer_type).toBe("Standard");
      expect(attrs.kind).toBe("GlobalDocumentDB");
      expect(attrs.capabilities).toEqual(["EnableServerless", "EnableTable"]);
    });

    it("should handle MongoDB kind", () => {
      const block = { kind: "MongoDB", offer_type: "Standard" };
      const attrs = extract(block);
      expect(attrs.kind).toBe("MongoDB");
    });

    it("should handle empty capabilities array", () => {
      const block = { offer_type: "Standard", capabilities: [] };
      const attrs = extract(block);
      expect(attrs.capabilities).toBeUndefined();
    });

    it("should handle non-object items in capabilities", () => {
      const block = { capabilities: ["string-cap", null, { name: "Valid" }] };
      const attrs = extract(block);
      expect(attrs.capabilities).toEqual(["Valid"]);
    });

    it("should handle capabilities with missing name", () => {
      const block = { capabilities: [{ other: "field" }] };
      const attrs = extract(block);
      expect(attrs.capabilities).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_app_service_plan
  // -----------------------------------------------------------------------
  describe("azurerm_app_service_plan", () => {
    const extract = azureExtractors["azurerm_app_service_plan"];

    it("should extract sku block tier and size", () => {
      const block = {
        sku: [{ tier: "Standard", size: "S1" }],
      };
      const attrs = extract(block);
      expect(attrs.sku_tier).toBe("Standard");
      expect(attrs.sku_size).toBe("S1");
    });

    it("should extract newer sku_name attribute", () => {
      const block = { sku_name: "P1v3" };
      const attrs = extract(block);
      expect(attrs.sku).toBe("P1v3");
    });

    it("should handle both sku block and sku_name", () => {
      const block = {
        sku: [{ tier: "Premium", size: "P1" }],
        sku_name: "P1v3",
      };
      const attrs = extract(block);
      expect(attrs.sku_tier).toBe("Premium");
      expect(attrs.sku_size).toBe("P1");
      expect(attrs.sku).toBe("P1v3");
    });

    it("should handle missing sku block", () => {
      const attrs = extract({});
      expect(attrs.sku_tier).toBeUndefined();
      expect(attrs.sku_size).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_function_app
  // -----------------------------------------------------------------------
  describe("azurerm_function_app", () => {
    const extract = azureExtractors["azurerm_function_app"];

    it("should extract app service plan ID", () => {
      const block = { app_service_plan_id: "/subscriptions/.../plan1" };
      const attrs = extract(block);
      expect(attrs.app_service_plan_id).toBe("/subscriptions/.../plan1");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_redis_cache
  // -----------------------------------------------------------------------
  describe("azurerm_redis_cache", () => {
    const extract = azureExtractors["azurerm_redis_cache"];

    it("should extract capacity, family, and sku", () => {
      const block = {
        capacity: 2,
        family: "P",
        sku_name: "Premium",
      };
      const attrs = extract(block);
      expect(attrs.capacity).toBe(2);
      expect(attrs.family).toBe("P");
      expect(attrs.sku).toBe("Premium");
    });

    it("should handle Basic SKU", () => {
      const block = { capacity: 0, family: "C", sku_name: "Basic" };
      const attrs = extract(block);
      expect(attrs.capacity).toBe(0);
      expect(attrs.family).toBe("C");
      expect(attrs.sku).toBe("Basic");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_cosmosdb_sql_database
  // -----------------------------------------------------------------------
  describe("azurerm_cosmosdb_sql_database", () => {
    const extract = azureExtractors["azurerm_cosmosdb_sql_database"];

    it("should extract throughput", () => {
      const attrs = extract({ throughput: 400 });
      expect(attrs.throughput).toBe(400);
    });

    it("should handle zero throughput", () => {
      const attrs = extract({ throughput: 0 });
      expect(attrs.throughput).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_storage_account
  // -----------------------------------------------------------------------
  describe("azurerm_storage_account", () => {
    const extract = azureExtractors["azurerm_storage_account"];

    it("should extract account tier and replication type", () => {
      const block = {
        account_tier: "Standard",
        account_replication_type: "GRS",
      };
      const attrs = extract(block);
      expect(attrs.account_tier).toBe("Standard");
      expect(attrs.account_replication_type).toBe("GRS");
    });

    it("should handle Premium tier with LRS", () => {
      const block = {
        account_tier: "Premium",
        account_replication_type: "LRS",
      };
      const attrs = extract(block);
      expect(attrs.account_tier).toBe("Premium");
      expect(attrs.account_replication_type).toBe("LRS");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_container_registry
  // -----------------------------------------------------------------------
  describe("azurerm_container_registry", () => {
    const extract = azureExtractors["azurerm_container_registry"];

    it("should extract sku and location", () => {
      const block = { sku: "Premium", location: "eastus" };
      const attrs = extract(block);
      expect(attrs.sku).toBe("Premium");
      expect(attrs.location).toBe("eastus");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_key_vault
  // -----------------------------------------------------------------------
  describe("azurerm_key_vault", () => {
    const extract = azureExtractors["azurerm_key_vault"];

    it("should extract sku_name and location", () => {
      const block = { sku_name: "premium", location: "westus2" };
      const attrs = extract(block);
      expect(attrs.sku).toBe("premium");
      expect(attrs.location).toBe("westus2");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_dns_zone
  // -----------------------------------------------------------------------
  describe("azurerm_dns_zone", () => {
    const extract = azureExtractors["azurerm_dns_zone"];

    it("should extract zone name and resource group", () => {
      const block = {
        name: "example.com",
        resource_group_name: "rg-dns",
      };
      const attrs = extract(block);
      expect(attrs.zone_name).toBe("example.com");
      expect(attrs.resource_group_name).toBe("rg-dns");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_api_management
  // -----------------------------------------------------------------------
  describe("azurerm_api_management", () => {
    const extract = azureExtractors["azurerm_api_management"];

    it("should extract name, sku, and location", () => {
      const block = {
        name: "apim-prod",
        sku_name: "Developer_1",
        location: "eastus",
      };
      const attrs = extract(block);
      expect(attrs.api_name).toBe("apim-prod");
      expect(attrs.sku).toBe("Developer_1");
      expect(attrs.location).toBe("eastus");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_web_application_firewall_policy
  // -----------------------------------------------------------------------
  describe("azurerm_web_application_firewall_policy", () => {
    const extract = azureExtractors["azurerm_web_application_firewall_policy"];

    it("should extract policy name, location, and rule count", () => {
      const block = {
        name: "waf-policy",
        location: "eastus",
        custom_rules: [{}, {}, {}],
      };
      const attrs = extract(block);
      expect(attrs.policy_name).toBe("waf-policy");
      expect(attrs.location).toBe("eastus");
      expect(attrs.rule_count).toBe(3);
    });

    it("should handle missing custom_rules", () => {
      const block = { name: "waf-basic" };
      const attrs = extract(block);
      expect(attrs.policy_name).toBe("waf-basic");
      expect(attrs.rule_count).toBeUndefined();
    });

    it("should handle non-array custom_rules", () => {
      const block = { name: "waf", custom_rules: "not-array" };
      const attrs = extract(block);
      expect(attrs.rule_count).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      const attrs = extract({});
      expect(attrs.policy_name).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_servicebus_namespace
  // -----------------------------------------------------------------------
  describe("azurerm_servicebus_namespace", () => {
    const extract = azureExtractors["azurerm_servicebus_namespace"];

    it("should extract all namespace attributes", () => {
      const block = {
        name: "sb-prod",
        sku: "Premium",
        location: "eastus",
        capacity: 4,
      };
      const attrs = extract(block);
      expect(attrs.namespace_name).toBe("sb-prod");
      expect(attrs.sku).toBe("Premium");
      expect(attrs.location).toBe("eastus");
      expect(attrs.capacity).toBe(4);
    });

    it("should handle Standard SKU without capacity", () => {
      const block = { name: "sb-dev", sku: "Standard", location: "westus" };
      const attrs = extract(block);
      expect(attrs.sku).toBe("Standard");
      expect(attrs.capacity).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // azurerm_eventhub_namespace
  // -----------------------------------------------------------------------
  describe("azurerm_eventhub_namespace", () => {
    const extract = azureExtractors["azurerm_eventhub_namespace"];

    it("should extract all namespace attributes", () => {
      const block = {
        name: "eh-prod",
        sku: "Standard",
        location: "eastus",
        capacity: 2,
      };
      const attrs = extract(block);
      expect(attrs.namespace_name).toBe("eh-prod");
      expect(attrs.sku).toBe("Standard");
      expect(attrs.location).toBe("eastus");
      expect(attrs.capacity).toBe(2);
    });

    it("should handle zero capacity", () => {
      const block = { capacity: 0 };
      const attrs = extract(block);
      expect(attrs.capacity).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });
});
