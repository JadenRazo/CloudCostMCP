import type { ResourceAttributes } from "../../types/index.js";
import type { AttributeExtractor } from "./helpers.js";
import { firstBlock, str, num, bool } from "./helpers.js";

export const gcpExtractors: Record<string, AttributeExtractor> = {
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
    if (block["initial_node_count"] !== undefined)
      attrs.node_count = num(block["initial_node_count"]);
    if (str(block["location"])) attrs.zone = str(block["location"]);
    return attrs;
  },

  google_container_node_pool(block) {
    const nodeConfig = firstBlock(block, "node_config");
    const autoscaling = firstBlock(block, "autoscaling");
    const attrs: ResourceAttributes = {};
    if (str(nodeConfig["machine_type"])) attrs.machine_type = str(nodeConfig["machine_type"]);
    if (block["node_count"] !== undefined) attrs.node_count = num(block["node_count"]);
    if (autoscaling["min_node_count"] !== undefined)
      attrs.min_node_count = num(autoscaling["min_node_count"]);
    if (autoscaling["max_node_count"] !== undefined)
      attrs.max_node_count = num(autoscaling["max_node_count"]);
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
    if (block["available_memory_mb"] !== undefined)
      attrs.memory_size = num(block["available_memory_mb"]);
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

  google_secret_manager_secret(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["secret_id"])) attrs.secret_name = str(block["secret_id"]);
    return attrs;
  },

  google_dns_managed_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (str(block["dns_name"])) attrs.dns_name = str(block["dns_name"]);
    if (str(block["visibility"])) attrs.visibility = str(block["visibility"]);
    return attrs;
  },

  google_apigateway_api(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["api_id"])) attrs.api_name = str(block["api_id"]);
    return attrs;
  },

  google_pubsub_topic(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.topic_name = str(block["name"]);
    return attrs;
  },

  google_vertex_ai_endpoint(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["display_name"])) attrs.endpoint_name = str(block["display_name"]);
    // Machine type from dedicated_resources.machine_spec.machine_type
    const dedicatedResources = firstBlock(block, "dedicated_resources");
    const machineSpec = firstBlock(dedicatedResources, "machine_spec");
    if (str(machineSpec["machine_type"])) attrs.machine_type = str(machineSpec["machine_type"]);
    const autoscaling = firstBlock(dedicatedResources, "automatic_resources");
    if (autoscaling["min_replica_count"] !== undefined)
      attrs.instance_count = num(autoscaling["min_replica_count"]);
    return attrs;
  },

  google_pubsub_subscription(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.subscription_name = str(block["name"]);
    if (str(block["topic"])) attrs.topic = str(block["topic"]);
    return attrs;
  },
};
