import type { ResourceAttributes } from "../../types/index.js";
import type { AttributeExtractor } from "./helpers.js";
import { firstBlock, str, num } from "./helpers.js";

export const azureExtractors: Record<string, AttributeExtractor> = {
  azurerm_virtual_machine(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["vm_size"])) attrs.vm_size = str(block["vm_size"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_linux_virtual_machine(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["size"])) attrs.vm_size = str(block["size"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_windows_virtual_machine(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["size"])) attrs.vm_size = str(block["size"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    attrs.os = "Windows";
    return attrs;
  },

  azurerm_managed_disk(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["storage_account_type"])) attrs.storage_type = str(block["storage_account_type"]);
    if (block["disk_size_gb"] !== undefined) attrs.storage_size_gb = num(block["disk_size_gb"]);
    if (block["disk_iops_read_write"] !== undefined)
      attrs.iops = num(block["disk_iops_read_write"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_sql_server(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["version"])) attrs.engine_version = str(block["version"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_mssql_database(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    if (block["max_size_gb"] !== undefined) attrs.storage_size_gb = num(block["max_size_gb"]);
    return attrs;
  },

  azurerm_kubernetes_cluster(block) {
    const defaultPool = firstBlock(block, "default_node_pool");
    const attrs: ResourceAttributes = {};
    if (str(defaultPool["vm_size"])) attrs.vm_size = str(defaultPool["vm_size"]);
    if (defaultPool["node_count"] !== undefined) attrs.node_count = num(defaultPool["node_count"]);
    if (defaultPool["min_count"] !== undefined)
      attrs.min_node_count = num(defaultPool["min_count"]);
    if (defaultPool["max_count"] !== undefined)
      attrs.max_node_count = num(defaultPool["max_count"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_cosmosdb_account(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["offer_type"])) attrs.offer_type = str(block["offer_type"]);
    if (str(block["kind"])) attrs.kind = str(block["kind"]);
    // capabilities is an array of blocks with a "name" attribute
    const capabilities = block["capabilities"];
    if (Array.isArray(capabilities)) {
      const capNames = capabilities
        .map((c) =>
          typeof c === "object" && c !== null
            ? str((c as Record<string, unknown>)["name"])
            : undefined,
        )
        .filter((n): n is string => n !== undefined);
      if (capNames.length > 0) attrs.capabilities = capNames;
    }
    return attrs;
  },

  azurerm_app_service_plan(block) {
    const attrs: ResourceAttributes = {};
    const skuBlock = firstBlock(block, "sku");
    if (str(skuBlock["tier"])) attrs.sku_tier = str(skuBlock["tier"]);
    if (str(skuBlock["size"])) attrs.sku_size = str(skuBlock["size"]);
    // newer azurerm provider uses sku_name directly
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    return attrs;
  },

  azurerm_function_app(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["app_service_plan_id"]))
      attrs.app_service_plan_id = str(block["app_service_plan_id"]);
    return attrs;
  },

  azurerm_redis_cache(block) {
    const attrs: ResourceAttributes = {};
    if (block["capacity"] !== undefined) attrs.capacity = num(block["capacity"]);
    if (str(block["family"])) attrs.family = str(block["family"]);
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    return attrs;
  },

  azurerm_cosmosdb_sql_database(block) {
    const attrs: ResourceAttributes = {};
    if (block["throughput"] !== undefined) attrs.throughput = num(block["throughput"]);
    return attrs;
  },

  azurerm_storage_account(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["account_tier"])) attrs.account_tier = str(block["account_tier"]);
    if (str(block["account_replication_type"]))
      attrs.account_replication_type = str(block["account_replication_type"]);
    return attrs;
  },

  azurerm_container_registry(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["sku"])) attrs.sku = str(block["sku"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_key_vault(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_dns_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (str(block["resource_group_name"]))
      attrs.resource_group_name = str(block["resource_group_name"]);
    return attrs;
  },

  azurerm_api_management(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.api_name = str(block["name"]);
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  azurerm_web_application_firewall_policy(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.policy_name = str(block["name"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    // Count custom rules if provided
    const customRules = block["custom_rules"];
    if (Array.isArray(customRules)) {
      attrs.rule_count = customRules.length;
    }
    return attrs;
  },

  azurerm_servicebus_namespace(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.namespace_name = str(block["name"]);
    if (str(block["sku"])) attrs.sku = str(block["sku"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    if (block["capacity"] !== undefined) attrs.capacity = num(block["capacity"]);
    return attrs;
  },

  azurerm_eventhub_namespace(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.namespace_name = str(block["name"]);
    if (str(block["sku"])) attrs.sku = str(block["sku"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    if (block["capacity"] !== undefined) attrs.capacity = num(block["capacity"]);
    return attrs;
  },
};
