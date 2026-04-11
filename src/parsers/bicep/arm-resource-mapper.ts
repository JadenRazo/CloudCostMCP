import type { ParsedResource } from "../../types/resources.js";
import type { ArmResource } from "./arm-types.js";

/** Map from ARM resource type (case-insensitive key) to internal Terraform-style type. */
const ARM_TYPE_MAP: Record<string, string> = {
  "microsoft.compute/virtualmachines": "azurerm_linux_virtual_machine",
  "microsoft.compute/disks": "azurerm_managed_disk",
  "microsoft.dbforpostgresql/flexibleservers": "azurerm_postgresql_flexible_server",
  "microsoft.dbformysql/flexibleservers": "azurerm_mysql_flexible_server",
  "microsoft.sql/servers": "azurerm_mssql_database",
  "microsoft.storage/storageaccounts": "azurerm_storage_account",
  "microsoft.network/loadbalancers": "azurerm_lb",
  "microsoft.network/natgateways": "azurerm_nat_gateway",
  "microsoft.containerservice/managedclusters": "azurerm_kubernetes_cluster",
  "microsoft.web/serverfarms": "azurerm_app_service_plan",
  "microsoft.web/sites": "azurerm_function_app",
  "microsoft.keyvault/vaults": "azurerm_key_vault",
  "microsoft.network/dnszones": "azurerm_dns_zone",
  "microsoft.containerregistry/registries": "azurerm_container_registry",
  "microsoft.documentdb/databaseaccounts": "azurerm_cosmosdb_account",
};

/**
 * Map a single ARM resource to the internal ParsedResource format.
 * Returns null for unsupported resource types (and pushes a warning).
 */
export function mapArmResource(
  resource: ArmResource,
  region: string,
  parameters: Record<string, unknown>,
  filePath: string,
  warnings: string[],
): ParsedResource | null {
  const internalType = ARM_TYPE_MAP[resource.type.toLowerCase()];
  if (!internalType) {
    warnings.push(`Unsupported ARM resource type: ${resource.type} (${resource.name})`);
    return null;
  }

  const props = resource.properties ?? {};
  const resolvedLocation = resolveParam(resource.location, parameters);
  const effectiveRegion = typeof resolvedLocation === "string" ? resolvedLocation : region;

  const attributes = extractAttributes(resource.type.toLowerCase(), props, resource, parameters);

  return {
    id: resource.name,
    type: internalType,
    name: resource.name,
    provider: "azure",
    region: effectiveRegion,
    attributes,
    tags: resource.tags ?? {},
    source_file: filePath,
  };
}

/**
 * Resolve a simple ARM parameter reference like `[parameters('name')]`.
 * Returns the resolved value if the pattern matches, or the original value.
 */
function resolveParam(value: unknown, parameters: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(/^\[parameters\('([^']+)'\)]$/);
  if (match) {
    const paramName = match[1];
    return paramName in parameters ? parameters[paramName] : value;
  }
  return value;
}

function extractAttributes(
  armTypeLower: string,
  props: Record<string, unknown>,
  resource: ArmResource,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  switch (armTypeLower) {
    case "microsoft.compute/virtualmachines": {
      const hw = props.hardwareProfile as Record<string, unknown> | undefined;
      const rawSize = hw?.vmSize;
      const vmSize = resolveParam(rawSize, parameters);
      return {
        vm_size: typeof vmSize === "string" ? vmSize : undefined,
      };
    }

    case "microsoft.compute/disks": {
      const diskProps = props as Record<string, unknown>;
      return {
        sku: resource.sku?.name,
        storage_size_gb: asNumber(diskProps.diskSizeGB),
      };
    }

    case "microsoft.dbforpostgresql/flexibleservers": {
      const storage = props.storage as Record<string, unknown> | undefined;
      return {
        sku: resource.sku?.name,
        storage_size_gb: asNumber(storage?.storageSizeGB),
      };
    }

    case "microsoft.dbformysql/flexibleservers":
      return {
        sku: resource.sku?.name,
      };

    case "microsoft.sql/servers":
      return {};

    case "microsoft.storage/storageaccounts":
      return {
        sku: resource.sku?.name,
        kind: resource.kind,
      };

    case "microsoft.network/loadbalancers":
      return {
        sku: resource.sku?.name,
      };

    case "microsoft.network/natgateways":
      return {};

    case "microsoft.containerservice/managedclusters": {
      const pools = props.agentPoolProfiles as Array<Record<string, unknown>> | undefined;
      const firstPool = pools?.[0];
      return {
        node_count: asNumber(firstPool?.count),
        vm_size: typeof firstPool?.vmSize === "string" ? firstPool.vmSize : undefined,
      };
    }

    case "microsoft.web/serverfarms":
      return {
        sku: resource.sku?.name,
        tier: resource.sku?.tier,
      };

    case "microsoft.web/sites":
      return {
        kind: resource.kind,
      };

    case "microsoft.keyvault/vaults":
      return {
        sku: resource.sku?.name,
      };

    case "microsoft.network/dnszones":
      return {};

    case "microsoft.containerregistry/registries":
      return {
        sku: resource.sku?.name,
      };

    case "microsoft.documentdb/databaseaccounts": {
      const dbProps = props as Record<string, unknown>;
      return {
        kind: resource.kind,
        database_account_offer_type:
          typeof dbProps.databaseAccountOfferType === "string"
            ? dbProps.databaseAccountOfferType
            : undefined,
      };
    }

    default:
      return {};
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}
