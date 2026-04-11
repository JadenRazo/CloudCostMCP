import { describe, it, expect } from "vitest";
import { awsExtractors } from "../../../src/parsers/extractors/aws-extractor.js";

// ---------------------------------------------------------------------------
// AWS Extractor Tests
// ---------------------------------------------------------------------------

describe("awsExtractors", () => {
  // -----------------------------------------------------------------------
  // aws_instance (EC2)
  // -----------------------------------------------------------------------
  describe("aws_instance", () => {
    const extract = awsExtractors["aws_instance"];

    it("should extract all attributes from a fully specified block", () => {
      const block = {
        instance_type: "t3.medium",
        ami: "ami-0abcdef1234567890",
        availability_zone: "us-east-1a",
        root_block_device: [
          {
            volume_type: "gp3",
            volume_size: 100,
            iops: 3000,
            throughput: 125,
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("t3.medium");
      expect(attrs.ami).toBe("ami-0abcdef1234567890");
      expect(attrs.availability_zone).toBe("us-east-1a");
      expect(attrs.storage_type).toBe("gp3");
      expect(attrs.storage_size_gb).toBe(100);
      expect(attrs.iops).toBe(3000);
      expect(attrs.throughput_mbps).toBe(125);
    });

    it("should handle missing root_block_device gracefully", () => {
      const block = { instance_type: "m5.large" };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("m5.large");
      expect(attrs.storage_type).toBeUndefined();
      expect(attrs.storage_size_gb).toBeUndefined();
    });

    it("should handle empty block returning empty attributes", () => {
      const attrs = extract({});
      expect(Object.keys(attrs).length).toBe(0);
    });

    it("should handle root_block_device as empty array", () => {
      const block = {
        instance_type: "t3.micro",
        root_block_device: [],
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("t3.micro");
      expect(attrs.storage_type).toBeUndefined();
    });

    it("should handle numeric strings for volume_size", () => {
      const block = {
        root_block_device: [{ volume_size: "50" }],
      };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(50);
    });

    it("should handle zero iops and throughput", () => {
      const block = {
        root_block_device: [{ iops: 0, throughput: 0 }],
      };
      const attrs = extract(block);
      expect(attrs.iops).toBe(0);
      expect(attrs.throughput_mbps).toBe(0);
    });

    it("should ignore empty string instance_type", () => {
      const block = { instance_type: "" };
      const attrs = extract(block);
      expect(attrs.instance_type).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // aws_db_instance (RDS)
  // -----------------------------------------------------------------------
  describe("aws_db_instance", () => {
    const extract = awsExtractors["aws_db_instance"];

    it("should extract all RDS attributes", () => {
      const block = {
        instance_class: "db.r5.large",
        engine: "mysql",
        engine_version: "8.0",
        storage_type: "gp3",
        allocated_storage: 100,
        iops: 3000,
        multi_az: true,
        replicas: 2,
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("db.r5.large");
      expect(attrs.engine).toBe("mysql");
      expect(attrs.engine_version).toBe("8.0");
      expect(attrs.storage_type).toBe("gp3");
      expect(attrs.storage_size_gb).toBe(100);
      expect(attrs.iops).toBe(3000);
      expect(attrs.multi_az).toBe(true);
      expect(attrs.replicas).toBe(2);
    });

    it("should handle multi_az as string boolean", () => {
      const block = { multi_az: "false" };
      const attrs = extract(block);
      expect(attrs.multi_az).toBe(false);
    });

    it("should handle allocated_storage of zero", () => {
      const block = { allocated_storage: 0 };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });

    it("should return empty attributes for empty block", () => {
      const attrs = extract({});
      expect(Object.keys(attrs).length).toBe(0);
    });

    it("should handle string allocated_storage", () => {
      const block = { allocated_storage: "200" };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // aws_rds_cluster
  // -----------------------------------------------------------------------
  describe("aws_rds_cluster", () => {
    const extract = awsExtractors["aws_rds_cluster"];

    it("should extract Aurora cluster attributes", () => {
      const block = {
        engine: "aurora-mysql",
        engine_version: "5.7.mysql_aurora.2.11.2",
        db_cluster_instance_class: "db.r6g.large",
        master_username: "admin",
      };
      const attrs = extract(block);
      expect(attrs.engine).toBe("aurora-mysql");
      expect(attrs.engine_version).toBe("5.7.mysql_aurora.2.11.2");
      expect(attrs.instance_type).toBe("db.r6g.large");
      expect(attrs.master_username).toBe("admin");
    });

    it("should handle serverless Aurora without instance class", () => {
      const block = { engine: "aurora-postgresql" };
      const attrs = extract(block);
      expect(attrs.engine).toBe("aurora-postgresql");
      expect(attrs.instance_type).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_s3_bucket
  // -----------------------------------------------------------------------
  describe("aws_s3_bucket", () => {
    const extract = awsExtractors["aws_s3_bucket"];

    it("should extract storage class from lifecycle transition", () => {
      const block = {
        bucket: "my-app-data",
        lifecycle_rule: [
          {
            transition: [{ storage_class: "GLACIER" }],
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("GLACIER");
      expect(attrs.bucket).toBe("my-app-data");
    });

    it("should handle missing lifecycle_rule", () => {
      const block = { bucket: "simple-bucket" };
      const attrs = extract(block);
      expect(attrs.bucket).toBe("simple-bucket");
      expect(attrs.storage_type).toBeUndefined();
    });

    it("should handle empty lifecycle_rule array", () => {
      const block = {
        bucket: "test-bucket",
        lifecycle_rule: [],
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBeUndefined();
    });

    it("should handle lifecycle_rule without transition", () => {
      const block = {
        lifecycle_rule: [{ enabled: true }],
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_lb / aws_alb
  // -----------------------------------------------------------------------
  describe("aws_lb", () => {
    const extract = awsExtractors["aws_lb"];

    it("should extract load balancer type and internal flag", () => {
      const block = {
        load_balancer_type: "application",
        internal: false,
      };
      const attrs = extract(block);
      expect(attrs.load_balancer_type).toBe("application");
      expect(attrs.internal).toBe(false);
    });

    it("should handle network load balancer", () => {
      const block = {
        load_balancer_type: "network",
        internal: true,
      };
      const attrs = extract(block);
      expect(attrs.load_balancer_type).toBe("network");
      expect(attrs.internal).toBe(true);
    });

    it("should handle string boolean for internal", () => {
      const block = { internal: "true" };
      const attrs = extract(block);
      expect(attrs.internal).toBe(true);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  describe("aws_alb", () => {
    it("should delegate to aws_lb extractor", () => {
      const block = { load_balancer_type: "application", internal: false };
      const albAttrs = awsExtractors["aws_alb"](block);
      const lbAttrs = awsExtractors["aws_lb"](block);
      expect(albAttrs).toEqual(lbAttrs);
    });
  });

  // -----------------------------------------------------------------------
  // aws_nat_gateway
  // -----------------------------------------------------------------------
  describe("aws_nat_gateway", () => {
    const extract = awsExtractors["aws_nat_gateway"];

    it("should extract allocation_id", () => {
      const block = { allocation_id: "eipalloc-12345" };
      const attrs = extract(block);
      expect(attrs.allocation_id).toBe("eipalloc-12345");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_eks_cluster
  // -----------------------------------------------------------------------
  describe("aws_eks_cluster", () => {
    const extract = awsExtractors["aws_eks_cluster"];

    it("should extract cluster name", () => {
      const attrs = extract({ name: "production-cluster" });
      expect(attrs.cluster_name).toBe("production-cluster");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_eks_node_group
  // -----------------------------------------------------------------------
  describe("aws_eks_node_group", () => {
    const extract = awsExtractors["aws_eks_node_group"];

    it("should extract instance type and scaling config", () => {
      const block = {
        instance_types: ["m5.xlarge"],
        scaling_config: [
          {
            desired_size: 3,
            min_size: 1,
            max_size: 10,
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("m5.xlarge");
      expect(attrs.node_count).toBe(3);
      expect(attrs.min_node_count).toBe(1);
      expect(attrs.max_node_count).toBe(10);
    });

    it("should handle empty instance_types array", () => {
      const block = { instance_types: [] };
      const attrs = extract(block);
      expect(attrs.instance_type).toBeUndefined();
    });

    it("should handle missing scaling_config", () => {
      const block = { instance_types: ["t3.medium"] };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("t3.medium");
      expect(attrs.node_count).toBeUndefined();
    });

    it("should handle non-array instance_types", () => {
      const block = { instance_types: "m5.large" };
      const attrs = extract(block);
      expect(attrs.instance_type).toBeUndefined();
    });

    it("should handle scaling_config with zero desired_size", () => {
      const block = {
        scaling_config: [{ desired_size: 0, min_size: 0, max_size: 5 }],
      };
      const attrs = extract(block);
      expect(attrs.node_count).toBe(0);
      expect(attrs.min_node_count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_elasticache_cluster
  // -----------------------------------------------------------------------
  describe("aws_elasticache_cluster", () => {
    const extract = awsExtractors["aws_elasticache_cluster"];

    it("should extract all ElastiCache attributes", () => {
      const block = {
        node_type: "cache.r6g.large",
        engine: "redis",
        engine_version: "7.0",
        num_cache_nodes: 3,
        az_mode: "cross-az",
        parameter_group_name: "default.redis7",
        port: 6379,
        subnet_group_name: "my-subnet-group",
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("cache.r6g.large");
      expect(attrs.engine).toBe("redis");
      expect(attrs.engine_version).toBe("7.0");
      expect(attrs.node_count).toBe(3);
      expect(attrs.az_mode).toBe("cross-az");
      expect(attrs.parameter_group_name).toBe("default.redis7");
      expect(attrs.port).toBe(6379);
      expect(attrs.subnet_group_name).toBe("my-subnet-group");
    });

    it("should handle memcached engine", () => {
      const block = {
        node_type: "cache.m5.large",
        engine: "memcached",
        num_cache_nodes: 2,
      };
      const attrs = extract(block);
      expect(attrs.engine).toBe("memcached");
      expect(attrs.node_count).toBe(2);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_elasticache_replication_group
  // -----------------------------------------------------------------------
  describe("aws_elasticache_replication_group", () => {
    const extract = awsExtractors["aws_elasticache_replication_group"];

    it("should extract node type and cluster count", () => {
      const block = {
        node_type: "cache.r6g.xlarge",
        num_cache_clusters: 3,
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("cache.r6g.xlarge");
      expect(attrs.node_count).toBe(3);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_ebs_volume
  // -----------------------------------------------------------------------
  describe("aws_ebs_volume", () => {
    const extract = awsExtractors["aws_ebs_volume"];

    it("should extract all EBS volume attributes", () => {
      const block = {
        type: "io2",
        size: 500,
        iops: 10000,
        throughput: 500,
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("io2");
      expect(attrs.storage_size_gb).toBe(500);
      expect(attrs.iops).toBe(10000);
      expect(attrs.throughput_mbps).toBe(500);
    });

    it("should handle gp2 volume with just size", () => {
      const block = { type: "gp2", size: 20 };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("gp2");
      expect(attrs.storage_size_gb).toBe(20);
      expect(attrs.iops).toBeUndefined();
    });

    it("should handle size as string", () => {
      const block = { size: "100" };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(100);
    });

    it("should handle zero size", () => {
      const block = { size: 0 };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_lambda_function
  // -----------------------------------------------------------------------
  describe("aws_lambda_function", () => {
    const extract = awsExtractors["aws_lambda_function"];

    it("should extract all Lambda attributes", () => {
      const block = {
        memory_size: 512,
        timeout: 30,
        architecture: "arm64",
        runtime: "nodejs18.x",
      };
      const attrs = extract(block);
      expect(attrs.memory_size).toBe(512);
      expect(attrs.timeout).toBe(30);
      expect(attrs.architecture).toBe("arm64");
      expect(attrs.runtime).toBe("nodejs18.x");
    });

    it("should prefer architecture string over architectures array", () => {
      const block = {
        architecture: "x86_64",
        architectures: ["arm64"],
      };
      const attrs = extract(block);
      expect(attrs.architecture).toBe("x86_64");
    });

    it("should fall back to architectures array when architecture is absent", () => {
      const block = {
        architectures: ["arm64"],
        memory_size: 128,
      };
      const attrs = extract(block);
      expect(attrs.architecture).toBe("arm64");
    });

    it("should handle empty architectures array", () => {
      const block = { architectures: [] };
      const attrs = extract(block);
      expect(attrs.architecture).toBeUndefined();
    });

    it("should handle memory_size of zero", () => {
      const block = { memory_size: 0 };
      const attrs = extract(block);
      expect(attrs.memory_size).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_dynamodb_table
  // -----------------------------------------------------------------------
  describe("aws_dynamodb_table", () => {
    const extract = awsExtractors["aws_dynamodb_table"];

    it("should extract provisioned mode attributes", () => {
      const block = {
        billing_mode: "PROVISIONED",
        read_capacity: 10,
        write_capacity: 5,
      };
      const attrs = extract(block);
      expect(attrs.billing_mode).toBe("PROVISIONED");
      expect(attrs.read_capacity).toBe(10);
      expect(attrs.write_capacity).toBe(5);
    });

    it("should extract on-demand mode", () => {
      const block = { billing_mode: "PAY_PER_REQUEST" };
      const attrs = extract(block);
      expect(attrs.billing_mode).toBe("PAY_PER_REQUEST");
      expect(attrs.read_capacity).toBeUndefined();
    });

    it("should handle zero capacity", () => {
      const block = { read_capacity: 0, write_capacity: 0 };
      const attrs = extract(block);
      expect(attrs.read_capacity).toBe(0);
      expect(attrs.write_capacity).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_efs_file_system
  // -----------------------------------------------------------------------
  describe("aws_efs_file_system", () => {
    const extract = awsExtractors["aws_efs_file_system"];

    it("should extract performance and throughput modes", () => {
      const block = {
        performance_mode: "maxIO",
        throughput_mode: "provisioned",
      };
      const attrs = extract(block);
      expect(attrs.performance_mode).toBe("maxIO");
      expect(attrs.throughput_mode).toBe("provisioned");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_cloudfront_distribution
  // -----------------------------------------------------------------------
  describe("aws_cloudfront_distribution", () => {
    const extract = awsExtractors["aws_cloudfront_distribution"];

    it("should extract price class", () => {
      const attrs = extract({ price_class: "PriceClass_100" });
      expect(attrs.price_class).toBe("PriceClass_100");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_sqs_queue
  // -----------------------------------------------------------------------
  describe("aws_sqs_queue", () => {
    const extract = awsExtractors["aws_sqs_queue"];

    it("should extract fifo_queue flag", () => {
      const attrs = extract({ fifo_queue: true });
      expect(attrs.fifo_queue).toBe(true);
    });

    it("should handle string boolean for fifo_queue", () => {
      const attrs = extract({ fifo_queue: "false" });
      expect(attrs.fifo_queue).toBe(false);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_ecr_repository
  // -----------------------------------------------------------------------
  describe("aws_ecr_repository", () => {
    const extract = awsExtractors["aws_ecr_repository"];

    it("should extract mutability and encryption", () => {
      const block = {
        image_tag_mutability: "IMMUTABLE",
        encryption_configuration: [{ encryption_type: "KMS" }],
      };
      const attrs = extract(block);
      expect(attrs.image_tag_mutability).toBe("IMMUTABLE");
      expect(attrs.encryption_type).toBe("KMS");
    });

    it("should handle missing encryption_configuration", () => {
      const block = { image_tag_mutability: "MUTABLE" };
      const attrs = extract(block);
      expect(attrs.image_tag_mutability).toBe("MUTABLE");
      expect(attrs.encryption_type).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_secretsmanager_secret
  // -----------------------------------------------------------------------
  describe("aws_secretsmanager_secret", () => {
    const extract = awsExtractors["aws_secretsmanager_secret"];

    it("should extract secret name and description", () => {
      const block = {
        name: "prod/db-password",
        description: "Production database password",
      };
      const attrs = extract(block);
      expect(attrs.secret_name).toBe("prod/db-password");
      expect(attrs.description).toBe("Production database password");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_route53_zone
  // -----------------------------------------------------------------------
  describe("aws_route53_zone", () => {
    const extract = awsExtractors["aws_route53_zone"];

    it("should extract zone name and private flag", () => {
      const block = {
        name: "example.com",
        private_zone: false,
      };
      const attrs = extract(block);
      expect(attrs.zone_name).toBe("example.com");
      expect(attrs.private_zone).toBe(false);
    });

    it("should handle private zone", () => {
      const block = { name: "internal.corp", private_zone: true };
      const attrs = extract(block);
      expect(attrs.private_zone).toBe(true);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_api_gateway_rest_api
  // -----------------------------------------------------------------------
  describe("aws_api_gateway_rest_api", () => {
    const extract = awsExtractors["aws_api_gateway_rest_api"];

    it("should extract name and set REST type", () => {
      const attrs = extract({ name: "my-api" });
      expect(attrs.api_name).toBe("my-api");
      expect(attrs.api_type).toBe("REST");
    });

    it("should always set api_type to REST even with empty block", () => {
      const attrs = extract({});
      expect(attrs.api_type).toBe("REST");
    });
  });

  // -----------------------------------------------------------------------
  // aws_apigatewayv2_api
  // -----------------------------------------------------------------------
  describe("aws_apigatewayv2_api", () => {
    const extract = awsExtractors["aws_apigatewayv2_api"];

    it("should extract HTTP api type", () => {
      const block = { name: "http-api", protocol_type: "HTTP" };
      const attrs = extract(block);
      expect(attrs.api_name).toBe("http-api");
      expect(attrs.api_type).toBe("HTTP");
    });

    it("should extract WEBSOCKET api type", () => {
      const block = { name: "ws-api", protocol_type: "WEBSOCKET" };
      const attrs = extract(block);
      expect(attrs.api_type).toBe("WEBSOCKET");
    });

    it("should handle lowercase websocket protocol", () => {
      const block = { protocol_type: "websocket" };
      const attrs = extract(block);
      expect(attrs.api_type).toBe("WEBSOCKET");
    });

    it("should default to HTTP when protocol_type is missing", () => {
      const attrs = extract({ name: "default-api" });
      expect(attrs.api_type).toBe("HTTP");
    });

    it("should default to HTTP for unknown protocol types", () => {
      const block = { protocol_type: "GRPC" };
      const attrs = extract(block);
      expect(attrs.api_type).toBe("HTTP");
    });
  });

  // -----------------------------------------------------------------------
  // aws_wafv2_web_acl
  // -----------------------------------------------------------------------
  describe("aws_wafv2_web_acl", () => {
    const extract = awsExtractors["aws_wafv2_web_acl"];

    it("should extract name, scope, and rule count", () => {
      const block = {
        name: "my-waf",
        scope: "REGIONAL",
        rule: [{}, {}, {}],
      };
      const attrs = extract(block);
      expect(attrs.acl_name).toBe("my-waf");
      expect(attrs.scope).toBe("REGIONAL");
      expect(attrs.rule_count).toBe(3);
    });

    it("should handle CLOUDFRONT scope", () => {
      const block = { name: "cf-waf", scope: "CLOUDFRONT" };
      const attrs = extract(block);
      expect(attrs.scope).toBe("CLOUDFRONT");
      expect(attrs.rule_count).toBeUndefined();
    });

    it("should handle non-array rule field", () => {
      const block = { name: "test", rule: "not-an-array" };
      const attrs = extract(block);
      expect(attrs.rule_count).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      const attrs = extract({});
      expect(attrs.acl_name).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // aws_opensearch_domain
  // -----------------------------------------------------------------------
  describe("aws_opensearch_domain", () => {
    const extract = awsExtractors["aws_opensearch_domain"];

    it("should extract cluster config and EBS options", () => {
      const block = {
        cluster_config: [
          {
            instance_type: "r6g.large.search",
            instance_count: 3,
          },
        ],
        ebs_options: [
          {
            volume_size: 100,
            volume_type: "gp3",
          },
        ],
        engine_version: "OpenSearch_2.5",
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("r6g.large.search");
      expect(attrs.instance_count).toBe(3);
      expect(attrs.volume_size).toBe(100);
      expect(attrs.volume_type).toBe("gp3");
      expect(attrs.engine_version).toBe("OpenSearch_2.5");
    });

    it("should handle missing cluster_config and ebs_options", () => {
      const block = { engine_version: "OpenSearch_1.0" };
      const attrs = extract(block);
      expect(attrs.engine_version).toBe("OpenSearch_1.0");
      expect(attrs.instance_type).toBeUndefined();
      expect(attrs.volume_size).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_sns_topic
  // -----------------------------------------------------------------------
  describe("aws_sns_topic", () => {
    const extract = awsExtractors["aws_sns_topic"];

    it("should extract topic name and fifo flag", () => {
      const block = { name: "order-events.fifo", fifo_topic: true };
      const attrs = extract(block);
      expect(attrs.topic_name).toBe("order-events.fifo");
      expect(attrs.fifo_topic).toBe(true);
    });

    it("should handle standard topic", () => {
      const block = { name: "notifications" };
      const attrs = extract(block);
      expect(attrs.topic_name).toBe("notifications");
      expect(attrs.fifo_topic).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_sagemaker_endpoint
  // -----------------------------------------------------------------------
  describe("aws_sagemaker_endpoint", () => {
    const extract = awsExtractors["aws_sagemaker_endpoint"];

    it("should extract endpoint name and production variant details", () => {
      const block = {
        name: "ml-endpoint",
        production_variants: [
          {
            instance_type: "ml.m5.xlarge",
            initial_instance_count: 2,
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.endpoint_name).toBe("ml-endpoint");
      expect(attrs.instance_type).toBe("ml.m5.xlarge");
      expect(attrs.instance_count).toBe(2);
    });

    it("should handle empty production_variants array", () => {
      const block = { name: "test-endpoint", production_variants: [] };
      const attrs = extract(block);
      expect(attrs.endpoint_name).toBe("test-endpoint");
      expect(attrs.instance_type).toBeUndefined();
    });

    it("should handle missing production_variants", () => {
      const block = { name: "test" };
      const attrs = extract(block);
      expect(attrs.instance_type).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // aws_mq_broker
  // -----------------------------------------------------------------------
  describe("aws_mq_broker", () => {
    const extract = awsExtractors["aws_mq_broker"];

    it("should extract all MQ broker attributes", () => {
      const block = {
        host_instance_type: "mq.m5.large",
        engine_type: "ActiveMQ",
        deployment_mode: "ACTIVE_STANDBY_MULTI_AZ",
        storage_type: "efs",
      };
      const attrs = extract(block);
      expect(attrs.instance_type).toBe("mq.m5.large");
      expect(attrs.engine_type).toBe("ActiveMQ");
      expect(attrs.deployment_mode).toBe("ACTIVE_STANDBY_MULTI_AZ");
      expect(attrs.storage_type).toBe("efs");
    });

    it("should handle RabbitMQ engine", () => {
      const block = {
        host_instance_type: "mq.m5.large",
        engine_type: "RabbitMQ",
        deployment_mode: "SINGLE_INSTANCE",
      };
      const attrs = extract(block);
      expect(attrs.engine_type).toBe("RabbitMQ");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });
});
