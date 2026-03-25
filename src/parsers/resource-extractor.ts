import type {
  ParsedResource,
  ResourceAttributes,
  CloudProvider,
} from "../types/index.js";
import { detectProvider } from "./provider-detector.js";
import { substituteVariables } from "./variable-resolver.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Region detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect the default region for a given provider by inspecting the top-level
 * `provider` block in the parsed HCL JSON. Falls back to a sensible default
 * when no region can be found.
 */
export function detectRegionFromProviders(
  hclJson: Record<string, unknown>,
  provider: CloudProvider,
  variables: Record<string, unknown>
): string {
  const defaults: Record<CloudProvider, string> = {
    aws: "us-east-1",
    azure: "eastus",
    gcp: "us-central1",
  };

  const providerBlock = hclJson["provider"];
  if (!providerBlock || typeof providerBlock !== "object") {
    return defaults[provider];
  }

  const providerKeyMap: Record<CloudProvider, string> = {
    aws: "aws",
    azure: "azurerm",
    gcp: "google",
  };

  const key = providerKeyMap[provider];
  const declarations = (providerBlock as Record<string, unknown>)[key];
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return defaults[provider];
  }

  const declaration = declarations[0] as Record<string, unknown>;

  // Region attribute name varies per provider
  const regionAttr = provider === "azure" ? "location" : "region";
  const rawRegion = declaration[regionAttr];
  if (!rawRegion) return defaults[provider];

  const resolved = substituteVariables(rawRegion, variables);
  if (typeof resolved === "string" && resolved && !resolved.startsWith("${")) {
    return resolved;
  }

  return defaults[provider];
}

// ---------------------------------------------------------------------------
// Per-resource-type attribute extraction
// ---------------------------------------------------------------------------

type AttributeExtractor = (
  block: Record<string, unknown>
) => ResourceAttributes;

/**
 * Attempt to read a nested block list and return the first element, or an
 * empty object when the structure is absent.
 */
function firstBlock(
  block: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const nested = block[key];
  if (Array.isArray(nested) && nested.length > 0) {
    return nested[0] as Record<string, unknown>;
  }
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

const extractors: Record<string, AttributeExtractor> = {
  aws_instance(block) {
    const root = firstBlock(block, "root_block_device");
    const attrs: ResourceAttributes = {};
    if (str(block["instance_type"])) attrs.instance_type = str(block["instance_type"]);
    if (str(block["ami"])) attrs.ami = str(block["ami"]);
    if (str(block["availability_zone"])) attrs.availability_zone = str(block["availability_zone"]);
    if (root["volume_type"]) attrs.storage_type = str(root["volume_type"]);
    if (root["volume_size"] !== undefined) attrs.storage_size_gb = num(root["volume_size"]);
    if (root["iops"] !== undefined) attrs.iops = num(root["iops"]);
    if (root["throughput"] !== undefined) attrs.throughput_mbps = num(root["throughput"]);
    return attrs;
  },

  aws_db_instance(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["instance_class"])) attrs.instance_type = str(block["instance_class"]);
    if (str(block["engine"])) attrs.engine = str(block["engine"]);
    if (str(block["engine_version"])) attrs.engine_version = str(block["engine_version"]);
    if (str(block["storage_type"])) attrs.storage_type = str(block["storage_type"]);
    if (block["allocated_storage"] !== undefined) attrs.storage_size_gb = num(block["allocated_storage"]);
    if (block["iops"] !== undefined) attrs.iops = num(block["iops"]);
    if (block["multi_az"] !== undefined) attrs.multi_az = bool(block["multi_az"]);
    if (block["replicas"] !== undefined) attrs.replicas = num(block["replicas"]);
    return attrs;
  },

  aws_rds_cluster(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["engine"])) attrs.engine = str(block["engine"]);
    if (str(block["engine_version"])) attrs.engine_version = str(block["engine_version"]);
    if (str(block["db_cluster_instance_class"])) attrs.instance_type = str(block["db_cluster_instance_class"]);
    if (block["master_username"]) attrs.master_username = str(block["master_username"]);
    return attrs;
  },

  aws_s3_bucket(block) {
    const attrs: ResourceAttributes = {};
    const lifecycle = firstBlock(block, "lifecycle_rule");
    const transition = firstBlock(lifecycle, "transition");
    if (str(transition["storage_class"])) attrs.storage_type = str(transition["storage_class"]);
    // Bucket name is useful for cost allocation
    if (str(block["bucket"])) attrs.bucket = str(block["bucket"]);
    return attrs;
  },

  aws_lb(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["load_balancer_type"])) attrs.load_balancer_type = str(block["load_balancer_type"]);
    if (block["internal"] !== undefined) attrs.internal = bool(block["internal"]);
    return attrs;
  },

  aws_alb(block) {
    return extractors["aws_lb"](block);
  },

  aws_nat_gateway(block) {
    // Presence alone determines cost; record allocation_id for traceability
    const attrs: ResourceAttributes = {};
    if (str(block["allocation_id"])) attrs.allocation_id = str(block["allocation_id"]);
    return attrs;
  },

  aws_eks_cluster(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.cluster_name = str(block["name"]);
    return attrs;
  },

  aws_eks_node_group(block) {
    const scaling = firstBlock(block, "scaling_config");
    const attrs: ResourceAttributes = {};
    const instanceTypes = block["instance_types"];
    if (Array.isArray(instanceTypes) && instanceTypes.length > 0) {
      attrs.instance_type = str(instanceTypes[0]);
    }
    if (scaling["desired_size"] !== undefined) attrs.node_count = num(scaling["desired_size"]);
    if (scaling["min_size"] !== undefined) attrs.min_node_count = num(scaling["min_size"]);
    if (scaling["max_size"] !== undefined) attrs.max_node_count = num(scaling["max_size"]);
    return attrs;
  },

  aws_elasticache_cluster(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["node_type"])) attrs.instance_type = str(block["node_type"]);
    if (str(block["engine"])) attrs.engine = str(block["engine"]);
    if (block["num_cache_nodes"] !== undefined) attrs.node_count = num(block["num_cache_nodes"]);
    return attrs;
  },

  aws_elasticache_replication_group(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["node_type"])) attrs.instance_type = str(block["node_type"]);
    if (block["num_cache_clusters"] !== undefined) attrs.node_count = num(block["num_cache_clusters"]);
    return attrs;
  },

  aws_ebs_volume(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["type"])) attrs.storage_type = str(block["type"]);
    if (block["size"] !== undefined) attrs.storage_size_gb = num(block["size"]);
    if (block["iops"] !== undefined) attrs.iops = num(block["iops"]);
    if (block["throughput"] !== undefined) attrs.throughput_mbps = num(block["throughput"]);
    return attrs;
  },

  aws_lambda_function(block) {
    const attrs: ResourceAttributes = {};
    if (block["memory_size"] !== undefined) attrs.memory_size = num(block["memory_size"]);
    if (block["timeout"] !== undefined) attrs.timeout = num(block["timeout"]);
    if (str(block["architecture"])) {
      attrs.architecture = str(block["architecture"]);
    } else {
      // architecture can also be an array in HCL JSON
      const arch = block["architectures"];
      if (Array.isArray(arch) && arch.length > 0) {
        attrs.architecture = str(arch[0]);
      }
    }
    if (str(block["runtime"])) attrs.runtime = str(block["runtime"]);
    return attrs;
  },

  aws_dynamodb_table(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["billing_mode"])) attrs.billing_mode = str(block["billing_mode"]);
    if (block["read_capacity"] !== undefined) attrs.read_capacity = num(block["read_capacity"]);
    if (block["write_capacity"] !== undefined) attrs.write_capacity = num(block["write_capacity"]);
    return attrs;
  },

  aws_efs_file_system(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["performance_mode"])) attrs.performance_mode = str(block["performance_mode"]);
    if (str(block["throughput_mode"])) attrs.throughput_mode = str(block["throughput_mode"]);
    return attrs;
  },

  aws_cloudfront_distribution(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["price_class"])) attrs.price_class = str(block["price_class"]);
    return attrs;
  },

  aws_sqs_queue(block) {
    const attrs: ResourceAttributes = {};
    if (block["fifo_queue"] !== undefined) attrs.fifo_queue = bool(block["fifo_queue"]);
    return attrs;
  },

  // ---------------------------------------------------------------------------
  // Azure
  // ---------------------------------------------------------------------------

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
    if (block["disk_iops_read_write"] !== undefined) attrs.iops = num(block["disk_iops_read_write"]);
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
    if (defaultPool["min_count"] !== undefined) attrs.min_node_count = num(defaultPool["min_count"]);
    if (defaultPool["max_count"] !== undefined) attrs.max_node_count = num(defaultPool["max_count"]);
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
        .map((c) => (typeof c === "object" && c !== null ? str((c as Record<string, unknown>)["name"]) : undefined))
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
    if (str(block["app_service_plan_id"])) attrs.app_service_plan_id = str(block["app_service_plan_id"]);
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
    if (str(block["account_replication_type"])) attrs.account_replication_type = str(block["account_replication_type"]);
    return attrs;
  },

  // ---------------------------------------------------------------------------
  // GCP
  // ---------------------------------------------------------------------------

  google_compute_instance(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["machine_type"])) attrs.machine_type = str(block["machine_type"]);
    if (str(block["zone"])) attrs.zone = str(block["zone"]);
    const boot = firstBlock(block, "boot_disk");
    const initParams = firstBlock(boot, "initialize_params");
    if (str(initParams["type"])) attrs.storage_type = str(initParams["type"]);
    if (initParams["size"] !== undefined) attrs.storage_size_gb = num(initParams["size"]);
    return attrs;
  },

  google_compute_disk(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["type"])) attrs.storage_type = str(block["type"]);
    if (block["size"] !== undefined) attrs.storage_size_gb = num(block["size"]);
    if (str(block["zone"])) attrs.zone = str(block["zone"]);
    return attrs;
  },

  google_sql_database_instance(block) {
    const settings = firstBlock(block, "settings");
    const attrs: ResourceAttributes = {};
    if (str(settings["tier"])) attrs.tier = str(settings["tier"]);
    if (str(block["database_version"])) attrs.engine = str(block["database_version"]);
    if (str(block["region"])) attrs.region_attr = str(block["region"]);
    const dataCacheConfig = firstBlock(settings, "data_cache_config");
    if (dataCacheConfig["data_cache_enabled"] !== undefined) {
      attrs.data_cache_enabled = bool(dataCacheConfig["data_cache_enabled"]);
    }
    return attrs;
  },

  google_container_cluster(block) {
    const nodeConfig = firstBlock(block, "node_config");
    const attrs: ResourceAttributes = {};
    if (str(nodeConfig["machine_type"])) attrs.machine_type = str(nodeConfig["machine_type"]);
    if (block["initial_node_count"] !== undefined) attrs.node_count = num(block["initial_node_count"]);
    if (str(block["location"])) attrs.zone = str(block["location"]);
    return attrs;
  },

  google_container_node_pool(block) {
    const nodeConfig = firstBlock(block, "node_config");
    const autoscaling = firstBlock(block, "autoscaling");
    const attrs: ResourceAttributes = {};
    if (str(nodeConfig["machine_type"])) attrs.machine_type = str(nodeConfig["machine_type"]);
    if (block["node_count"] !== undefined) attrs.node_count = num(block["node_count"]);
    if (autoscaling["min_node_count"] !== undefined) attrs.min_node_count = num(autoscaling["min_node_count"]);
    if (autoscaling["max_node_count"] !== undefined) attrs.max_node_count = num(autoscaling["max_node_count"]);
    return attrs;
  },

  google_cloud_run_service(block) {
    const attrs: ResourceAttributes = {};
    const template = firstBlock(block, "template");
    const spec = firstBlock(template, "spec");
    const container = firstBlock(spec, "containers");
    const resources = firstBlock(container, "resources");
    const limits = firstBlock(resources, "limits");
    if (str(limits["cpu"])) attrs.cpu = str(limits["cpu"]);
    if (str(limits["memory"])) attrs.memory = str(limits["memory"]);
    return attrs;
  },

  google_cloudfunctions_function(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["runtime"])) attrs.runtime = str(block["runtime"]);
    if (block["available_memory_mb"] !== undefined) attrs.memory_size = num(block["available_memory_mb"]);
    return attrs;
  },

  google_bigquery_dataset(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  google_redis_instance(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["tier"])) attrs.tier = str(block["tier"]);
    if (block["memory_size_gb"] !== undefined) attrs.memory_size = num(block["memory_size_gb"]);
    return attrs;
  },

  google_artifact_registry_repository(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["format"])) attrs.format = str(block["format"]);
    if (str(block["mode"])) attrs.mode = str(block["mode"]);
    return attrs;
  },

  // ---------------------------------------------------------------------------
  // Container Registries
  // ---------------------------------------------------------------------------

  aws_ecr_repository(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["image_tag_mutability"])) attrs.image_tag_mutability = str(block["image_tag_mutability"]);
    const encryptionConfig = firstBlock(block, "encryption_configuration");
    if (str(encryptionConfig["encryption_type"])) attrs.encryption_type = str(encryptionConfig["encryption_type"]);
    return attrs;
  },

  azurerm_container_registry(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["sku"])) attrs.sku = str(block["sku"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  // ---------------------------------------------------------------------------
  // Secrets Management
  // ---------------------------------------------------------------------------

  aws_secretsmanager_secret(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.secret_name = str(block["name"]);
    if (str(block["description"])) attrs.description = str(block["description"]);
    return attrs;
  },

  azurerm_key_vault(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["sku_name"])) attrs.sku = str(block["sku_name"]);
    if (str(block["location"])) attrs.location = str(block["location"]);
    return attrs;
  },

  google_secret_manager_secret(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["secret_id"])) attrs.secret_name = str(block["secret_id"]);
    return attrs;
  },

  // ---------------------------------------------------------------------------
  // DNS
  // ---------------------------------------------------------------------------

  aws_route53_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (block["private_zone"] !== undefined) attrs.private_zone = bool(block["private_zone"]);
    return attrs;
  },

  azurerm_dns_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (str(block["resource_group_name"])) attrs.resource_group_name = str(block["resource_group_name"]);
    return attrs;
  },

  google_dns_managed_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (str(block["dns_name"])) attrs.dns_name = str(block["dns_name"]);
    if (str(block["visibility"])) attrs.visibility = str(block["visibility"]);
    return attrs;
  },
};

// ---------------------------------------------------------------------------
// Region from resource-level attributes
// ---------------------------------------------------------------------------

/**
 * Some resource types carry their own region/zone/location attribute that can
 * be used as a fallback when no provider block region is available.
 */
function regionFromResourceBlock(
  resourceType: string,
  block: Record<string, unknown>,
  provider: CloudProvider
): string | undefined {
  switch (provider) {
    case "azure": {
      const loc = str(block["location"]);
      return loc && !loc.startsWith("${") ? loc : undefined;
    }
    case "gcp": {
      // zone like "us-central1-a" -> strip suffix
      const zone = str(block["zone"]);
      if (zone && !zone.startsWith("${")) {
        const parts = zone.split("-");
        return parts.length > 2 ? parts.slice(0, -1).join("-") : zone;
      }
      return str(block["region"]);
    }
    case "aws": {
      const az = str(block["availability_zone"]);
      if (az && !az.startsWith("${")) {
        const parts = az.split("-");
        return parts.length > 2 ? parts.slice(0, -1).join("-") : az;
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extractTags(block: Record<string, unknown>): Record<string, string> {
  const tags = block["tags"];
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
    else if (v !== null && v !== undefined) result[k] = String(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// count / for_each expansion helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `count` attribute to a concrete integer. Returns the count and
 * pushes a warning into the provided array when the value cannot be resolved.
 */
function resolveCount(
  rawCount: unknown,
  resourceId: string,
  warnings: string[]
): number {
  const n = num(rawCount);
  if (n !== undefined && Number.isInteger(n) && n >= 0) return n;

  // Could be a variable reference or expression that wasn't resolved
  warnings.push(
    `Resource "${resourceId}" has a count that could not be resolved to a number. Defaulting to 1.`
  );
  return 1;
}

/**
 * Resolve a `for_each` attribute to an array of keys. When the value is an
 * object, the object's keys are used. When it is an array, each element
 * (coerced to string) becomes a key. When neither can be determined a warning
 * is pushed and a single-element array `["0"]` is returned (equivalent to
 * count = 1).
 */
function resolveForEachKeys(
  rawForEach: unknown,
  resourceId: string,
  warnings: string[]
): string[] {
  if (rawForEach && typeof rawForEach === "object" && !Array.isArray(rawForEach)) {
    const keys = Object.keys(rawForEach as Record<string, unknown>);
    if (keys.length > 0) return keys;
  }

  if (Array.isArray(rawForEach) && rawForEach.length > 0) {
    return rawForEach.map((v, i) =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : String(i)
    );
  }

  // Unresolvable (e.g. still a variable reference string)
  warnings.push(
    `Resource "${resourceId}" has a for_each that could not be resolved. Defaulting to 1 instance.`
  );
  return ["0"];
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Walk the `resource` map in parsed HCL JSON and produce a flat array of
 * ParsedResource objects. Variable substitution is applied to all attribute
 * values before extraction so that downstream consumers always see resolved
 * strings/numbers wherever possible.
 *
 * count and for_each meta-arguments are expanded into multiple resources.
 * Data source blocks are silently skipped. Module blocks generate informational
 * warnings without being expanded.
 */
export function extractResources(
  hclJson: Record<string, unknown>,
  variables: Record<string, unknown>,
  sourceFile: string,
  defaultRegions: Partial<Record<CloudProvider, string>> = {},
  warnings: string[] = []
): ParsedResource[] {
  const resources: ParsedResource[] = [];

  const resourceBlock = hclJson["resource"];

  if (!resourceBlock || typeof resourceBlock !== "object") {
    return resources;
  }

  for (const [resourceType, instances] of Object.entries(
    resourceBlock as Record<string, unknown>
  )) {
    let provider: CloudProvider;
    try {
      provider = detectProvider(resourceType);
    } catch {
      logger.warn("Skipping resource with unknown provider prefix", {
        resourceType,
      });
      continue;
    }

    if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
      continue;
    }

    for (const [resourceName, blockList] of Object.entries(
      instances as Record<string, unknown>
    )) {
      if (!Array.isArray(blockList) || blockList.length === 0) continue;

      const rawBlock = blockList[0] as Record<string, unknown>;
      // Substitute variables throughout the entire block before extraction
      const block = substituteVariables(rawBlock, variables) as Record<
        string,
        unknown
      >;

      // Determine region: resource-level > provider default > hard default
      const resourceRegion = regionFromResourceBlock(resourceType, block, provider);
      const region =
        resourceRegion ??
        defaultRegions[provider] ??
        (provider === "aws"
          ? "us-east-1"
          : provider === "azure"
            ? "eastus"
            : "us-central1");

      // Extract cost-relevant attributes using per-type extractor or generic
      const extractor = extractors[resourceType];
      const attributes: ResourceAttributes = extractor
        ? extractor(block)
        : {};

      const tags = extractTags(block);
      const baseId = `${resourceType}.${resourceName}`;

      // ------------------------------------------------------------------
      // Expand count / for_each
      // ------------------------------------------------------------------

      const rawCount = block["count"];
      const rawForEach = block["for_each"];

      if (rawCount !== undefined) {
        // count expansion
        const count = resolveCount(rawCount, baseId, warnings);
        for (let i = 0; i < count; i++) {
          resources.push({
            id: `${baseId}[${i}]`,
            type: resourceType,
            name: resourceName,
            provider,
            region,
            attributes,
            tags,
            source_file: sourceFile,
          });
        }
      } else if (rawForEach !== undefined) {
        // for_each expansion
        const keys = resolveForEachKeys(rawForEach, baseId, warnings);
        for (const key of keys) {
          resources.push({
            id: `${baseId}["${key}"]`,
            type: resourceType,
            name: resourceName,
            provider,
            region,
            attributes,
            tags,
            source_file: sourceFile,
          });
        }
      } else {
        // No expansion – single resource
        resources.push({
          id: baseId,
          type: resourceType,
          name: resourceName,
          provider,
          region,
          attributes,
          tags,
          source_file: sourceFile,
        });
      }

      logger.debug("Extracted resource", {
        id: baseId,
        region,
        provider,
      });
    }
  }

  return resources;
}
