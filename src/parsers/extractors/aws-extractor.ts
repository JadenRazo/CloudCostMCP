import type { ResourceAttributes } from "../../types/index.js";
import type { AttributeExtractor } from "./helpers.js";
import { firstBlock, str, num, bool } from "./helpers.js";

export const awsExtractors: Record<string, AttributeExtractor> = {
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
    if (block["allocated_storage"] !== undefined)
      attrs.storage_size_gb = num(block["allocated_storage"]);
    if (block["iops"] !== undefined) attrs.iops = num(block["iops"]);
    if (block["multi_az"] !== undefined) attrs.multi_az = bool(block["multi_az"]);
    if (block["replicas"] !== undefined) attrs.replicas = num(block["replicas"]);
    return attrs;
  },

  aws_rds_cluster(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["engine"])) attrs.engine = str(block["engine"]);
    if (str(block["engine_version"])) attrs.engine_version = str(block["engine_version"]);
    if (str(block["db_cluster_instance_class"]))
      attrs.instance_type = str(block["db_cluster_instance_class"]);
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
    if (str(block["load_balancer_type"]))
      attrs.load_balancer_type = str(block["load_balancer_type"]);
    if (block["internal"] !== undefined) attrs.internal = bool(block["internal"]);
    return attrs;
  },

  aws_alb(block) {
    return awsExtractors["aws_lb"](block);
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
    if (str(block["engine_version"])) attrs.engine_version = str(block["engine_version"]);
    if (block["num_cache_nodes"] !== undefined) attrs.node_count = num(block["num_cache_nodes"]);
    if (str(block["az_mode"])) attrs.az_mode = str(block["az_mode"]);
    if (str(block["parameter_group_name"]))
      attrs.parameter_group_name = str(block["parameter_group_name"]);
    if (block["port"] !== undefined) attrs.port = num(block["port"]);
    if (str(block["subnet_group_name"])) attrs.subnet_group_name = str(block["subnet_group_name"]);
    return attrs;
  },

  aws_elasticache_replication_group(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["node_type"])) attrs.instance_type = str(block["node_type"]);
    if (block["num_cache_clusters"] !== undefined)
      attrs.node_count = num(block["num_cache_clusters"]);
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

  aws_ecr_repository(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["image_tag_mutability"]))
      attrs.image_tag_mutability = str(block["image_tag_mutability"]);
    const encryptionConfig = firstBlock(block, "encryption_configuration");
    if (str(encryptionConfig["encryption_type"]))
      attrs.encryption_type = str(encryptionConfig["encryption_type"]);
    return attrs;
  },

  aws_secretsmanager_secret(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.secret_name = str(block["name"]);
    if (str(block["description"])) attrs.description = str(block["description"]);
    return attrs;
  },

  aws_route53_zone(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.zone_name = str(block["name"]);
    if (block["private_zone"] !== undefined) attrs.private_zone = bool(block["private_zone"]);
    return attrs;
  },

  aws_api_gateway_rest_api(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.api_name = str(block["name"]);
    attrs.api_type = "REST";
    return attrs;
  },

  aws_apigatewayv2_api(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.api_name = str(block["name"]);
    const protocolType = str(block["protocol_type"]);
    if (protocolType) {
      attrs.api_type = protocolType.toUpperCase() === "WEBSOCKET" ? "WEBSOCKET" : "HTTP";
    } else {
      attrs.api_type = "HTTP";
    }
    return attrs;
  },

  aws_wafv2_web_acl(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.acl_name = str(block["name"]);
    if (str(block["scope"])) attrs.scope = str(block["scope"]);
    // Count rules if provided as an array
    const rules = block["rule"];
    if (Array.isArray(rules)) {
      attrs.rule_count = rules.length;
    }
    return attrs;
  },

  aws_opensearch_domain(block) {
    const clusterConfig = firstBlock(block, "cluster_config");
    const ebsOptions = firstBlock(block, "ebs_options");
    const attrs: ResourceAttributes = {};
    if (str(clusterConfig["instance_type"]))
      attrs.instance_type = str(clusterConfig["instance_type"]);
    if (clusterConfig["instance_count"] !== undefined)
      attrs.instance_count = num(clusterConfig["instance_count"]);
    if (ebsOptions["volume_size"] !== undefined) attrs.volume_size = num(ebsOptions["volume_size"]);
    if (str(ebsOptions["volume_type"])) attrs.volume_type = str(ebsOptions["volume_type"]);
    if (str(block["engine_version"])) attrs.engine_version = str(block["engine_version"]);
    return attrs;
  },

  aws_sns_topic(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.topic_name = str(block["name"]);
    if (block["fifo_topic"] !== undefined) attrs.fifo_topic = bool(block["fifo_topic"]);
    return attrs;
  },

  aws_sagemaker_endpoint(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["name"])) attrs.endpoint_name = str(block["name"]);
    // Instance type is typically in production_variants[0].instance_type
    const variants = block["production_variants"];
    if (Array.isArray(variants) && variants.length > 0) {
      const variant = variants[0] as Record<string, unknown>;
      if (str(variant["instance_type"])) attrs.instance_type = str(variant["instance_type"]);
      if (variant["initial_instance_count"] !== undefined)
        attrs.instance_count = num(variant["initial_instance_count"]);
    }
    return attrs;
  },

  aws_mq_broker(block) {
    const attrs: ResourceAttributes = {};
    if (str(block["host_instance_type"])) attrs.instance_type = str(block["host_instance_type"]);
    if (str(block["engine_type"])) attrs.engine_type = str(block["engine_type"]);
    if (str(block["deployment_mode"])) attrs.deployment_mode = str(block["deployment_mode"]);
    if (block["storage_type"]) attrs.storage_type = str(block["storage_type"]);
    return attrs;
  },
};
