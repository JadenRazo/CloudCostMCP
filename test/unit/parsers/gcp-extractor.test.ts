import { describe, it, expect } from "vitest";
import { gcpExtractors } from "../../../src/parsers/extractors/gcp-extractor.js";

// ---------------------------------------------------------------------------
// GCP Extractor Tests
// ---------------------------------------------------------------------------

describe("gcpExtractors", () => {
  // -----------------------------------------------------------------------
  // google_compute_instance
  // -----------------------------------------------------------------------
  describe("google_compute_instance", () => {
    const extract = gcpExtractors["google_compute_instance"];

    it("should extract machine type, zone, and boot disk attributes", () => {
      const block = {
        machine_type: "e2-standard-4",
        zone: "us-central1-a",
        boot_disk: [
          {
            initialize_params: [
              {
                type: "pd-ssd",
                size: 100,
              },
            ],
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("e2-standard-4");
      expect(attrs.zone).toBe("us-central1-a");
      expect(attrs.storage_type).toBe("pd-ssd");
      expect(attrs.storage_size_gb).toBe(100);
    });

    it("should handle missing boot_disk", () => {
      const block = { machine_type: "n1-standard-1", zone: "us-east1-b" };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("n1-standard-1");
      expect(attrs.zone).toBe("us-east1-b");
      expect(attrs.storage_type).toBeUndefined();
      expect(attrs.storage_size_gb).toBeUndefined();
    });

    it("should handle boot_disk without initialize_params", () => {
      const block = {
        machine_type: "n2-standard-2",
        boot_disk: [{}],
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("n2-standard-2");
      expect(attrs.storage_type).toBeUndefined();
    });

    it("should handle empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });

    it("should handle empty string machine_type", () => {
      const block = { machine_type: "" };
      const attrs = extract(block);
      expect(attrs.machine_type).toBeUndefined();
    });

    it("should handle string size in initialize_params", () => {
      const block = {
        boot_disk: [{ initialize_params: [{ size: "50" }] }],
      };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(50);
    });

    it("should handle zero size in initialize_params", () => {
      const block = {
        boot_disk: [{ initialize_params: [{ size: 0 }] }],
      };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_compute_disk
  // -----------------------------------------------------------------------
  describe("google_compute_disk", () => {
    const extract = gcpExtractors["google_compute_disk"];

    it("should extract all disk attributes", () => {
      const block = {
        type: "pd-ssd",
        size: 500,
        zone: "us-central1-a",
      };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("pd-ssd");
      expect(attrs.storage_size_gb).toBe(500);
      expect(attrs.zone).toBe("us-central1-a");
    });

    it("should handle pd-balanced type", () => {
      const block = { type: "pd-balanced", size: 100 };
      const attrs = extract(block);
      expect(attrs.storage_type).toBe("pd-balanced");
    });

    it("should handle zero size", () => {
      const block = { size: 0 };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(0);
    });

    it("should handle string size", () => {
      const block = { size: "200" };
      const attrs = extract(block);
      expect(attrs.storage_size_gb).toBe(200);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_sql_database_instance
  // -----------------------------------------------------------------------
  describe("google_sql_database_instance", () => {
    const extract = gcpExtractors["google_sql_database_instance"];

    it("should extract tier, engine, region, and data cache config", () => {
      const block = {
        settings: [
          {
            tier: "db-custom-4-15360",
            data_cache_config: [{ data_cache_enabled: true }],
          },
        ],
        database_version: "POSTGRES_15",
        region: "us-central1",
      };
      const attrs = extract(block);
      expect(attrs.tier).toBe("db-custom-4-15360");
      expect(attrs.engine).toBe("POSTGRES_15");
      expect(attrs.region_attr).toBe("us-central1");
      expect(attrs.data_cache_enabled).toBe(true);
    });

    it("should handle MySQL engine", () => {
      const block = {
        settings: [{ tier: "db-n1-standard-1" }],
        database_version: "MYSQL_8_0",
      };
      const attrs = extract(block);
      expect(attrs.tier).toBe("db-n1-standard-1");
      expect(attrs.engine).toBe("MYSQL_8_0");
    });

    it("should handle missing settings block", () => {
      const block = { database_version: "POSTGRES_14" };
      const attrs = extract(block);
      expect(attrs.engine).toBe("POSTGRES_14");
      expect(attrs.tier).toBeUndefined();
    });

    it("should handle settings without data_cache_config", () => {
      const block = {
        settings: [{ tier: "db-f1-micro" }],
      };
      const attrs = extract(block);
      expect(attrs.tier).toBe("db-f1-micro");
      expect(attrs.data_cache_enabled).toBeUndefined();
    });

    it("should handle data_cache_enabled as string boolean", () => {
      const block = {
        settings: [
          { data_cache_config: [{ data_cache_enabled: "false" }] },
        ],
      };
      const attrs = extract(block);
      expect(attrs.data_cache_enabled).toBe(false);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_container_cluster
  // -----------------------------------------------------------------------
  describe("google_container_cluster", () => {
    const extract = gcpExtractors["google_container_cluster"];

    it("should extract node config, initial count, and location", () => {
      const block = {
        node_config: [{ machine_type: "e2-standard-4" }],
        initial_node_count: 3,
        location: "us-central1",
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("e2-standard-4");
      expect(attrs.node_count).toBe(3);
      expect(attrs.zone).toBe("us-central1");
    });

    it("should handle missing node_config", () => {
      const block = { initial_node_count: 1, location: "us-east1" };
      const attrs = extract(block);
      expect(attrs.machine_type).toBeUndefined();
      expect(attrs.node_count).toBe(1);
    });

    it("should handle zero initial_node_count", () => {
      const block = { initial_node_count: 0 };
      const attrs = extract(block);
      expect(attrs.node_count).toBe(0);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_container_node_pool
  // -----------------------------------------------------------------------
  describe("google_container_node_pool", () => {
    const extract = gcpExtractors["google_container_node_pool"];

    it("should extract node config and autoscaling", () => {
      const block = {
        node_config: [{ machine_type: "n2-standard-8" }],
        node_count: 5,
        autoscaling: [
          {
            min_node_count: 2,
            max_node_count: 20,
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("n2-standard-8");
      expect(attrs.node_count).toBe(5);
      expect(attrs.min_node_count).toBe(2);
      expect(attrs.max_node_count).toBe(20);
    });

    it("should handle missing autoscaling", () => {
      const block = {
        node_config: [{ machine_type: "e2-medium" }],
        node_count: 3,
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBe("e2-medium");
      expect(attrs.node_count).toBe(3);
      expect(attrs.min_node_count).toBeUndefined();
      expect(attrs.max_node_count).toBeUndefined();
    });

    it("should handle missing node_config", () => {
      const block = { node_count: 1 };
      const attrs = extract(block);
      expect(attrs.machine_type).toBeUndefined();
      expect(attrs.node_count).toBe(1);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_cloud_run_service
  // -----------------------------------------------------------------------
  describe("google_cloud_run_service", () => {
    const extract = gcpExtractors["google_cloud_run_service"];

    it("should extract CPU and memory from deeply nested structure", () => {
      const block = {
        template: [
          {
            spec: [
              {
                containers: [
                  {
                    resources: [
                      {
                        limits: [{ cpu: "2", memory: "512Mi" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.cpu).toBe("2");
      expect(attrs.memory).toBe("512Mi");
    });

    it("should handle missing template", () => {
      const attrs = extract({});
      expect(attrs.cpu).toBeUndefined();
      expect(attrs.memory).toBeUndefined();
    });

    it("should handle template without spec", () => {
      const block = { template: [{}] };
      const attrs = extract(block);
      expect(attrs.cpu).toBeUndefined();
    });

    it("should handle spec without containers", () => {
      const block = { template: [{ spec: [{}] }] };
      const attrs = extract(block);
      expect(attrs.cpu).toBeUndefined();
    });

    it("should handle containers without resources", () => {
      const block = { template: [{ spec: [{ containers: [{}] }] }] };
      const attrs = extract(block);
      expect(attrs.cpu).toBeUndefined();
    });

    it("should handle resources without limits", () => {
      const block = {
        template: [{ spec: [{ containers: [{ resources: [{}] }] }] }],
      };
      const attrs = extract(block);
      expect(attrs.cpu).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // google_cloudfunctions_function
  // -----------------------------------------------------------------------
  describe("google_cloudfunctions_function", () => {
    const extract = gcpExtractors["google_cloudfunctions_function"];

    it("should extract runtime and memory", () => {
      const block = {
        runtime: "python311",
        available_memory_mb: 256,
      };
      const attrs = extract(block);
      expect(attrs.runtime).toBe("python311");
      expect(attrs.memory_size).toBe(256);
    });

    it("should handle string memory", () => {
      const block = { available_memory_mb: "512" };
      const attrs = extract(block);
      expect(attrs.memory_size).toBe(512);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_bigquery_dataset
  // -----------------------------------------------------------------------
  describe("google_bigquery_dataset", () => {
    const extract = gcpExtractors["google_bigquery_dataset"];

    it("should extract location", () => {
      const attrs = extract({ location: "US" });
      expect(attrs.location).toBe("US");
    });

    it("should handle EU multi-region", () => {
      const attrs = extract({ location: "EU" });
      expect(attrs.location).toBe("EU");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_redis_instance
  // -----------------------------------------------------------------------
  describe("google_redis_instance", () => {
    const extract = gcpExtractors["google_redis_instance"];

    it("should extract tier and memory size", () => {
      const block = {
        tier: "STANDARD_HA",
        memory_size_gb: 5,
      };
      const attrs = extract(block);
      expect(attrs.tier).toBe("STANDARD_HA");
      expect(attrs.memory_size).toBe(5);
    });

    it("should handle BASIC tier", () => {
      const block = { tier: "BASIC", memory_size_gb: 1 };
      const attrs = extract(block);
      expect(attrs.tier).toBe("BASIC");
      expect(attrs.memory_size).toBe(1);
    });

    it("should handle string memory_size_gb", () => {
      const block = { memory_size_gb: "16" };
      const attrs = extract(block);
      expect(attrs.memory_size).toBe(16);
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_artifact_registry_repository
  // -----------------------------------------------------------------------
  describe("google_artifact_registry_repository", () => {
    const extract = gcpExtractors["google_artifact_registry_repository"];

    it("should extract format and mode", () => {
      const block = { format: "DOCKER", mode: "STANDARD_REPOSITORY" };
      const attrs = extract(block);
      expect(attrs.format).toBe("DOCKER");
      expect(attrs.mode).toBe("STANDARD_REPOSITORY");
    });

    it("should handle NPM format", () => {
      const block = { format: "NPM" };
      const attrs = extract(block);
      expect(attrs.format).toBe("NPM");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_secret_manager_secret
  // -----------------------------------------------------------------------
  describe("google_secret_manager_secret", () => {
    const extract = gcpExtractors["google_secret_manager_secret"];

    it("should extract secret_id as secret_name", () => {
      const attrs = extract({ secret_id: "db-password" });
      expect(attrs.secret_name).toBe("db-password");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_dns_managed_zone
  // -----------------------------------------------------------------------
  describe("google_dns_managed_zone", () => {
    const extract = gcpExtractors["google_dns_managed_zone"];

    it("should extract zone name, dns_name, and visibility", () => {
      const block = {
        name: "prod-zone",
        dns_name: "example.com.",
        visibility: "public",
      };
      const attrs = extract(block);
      expect(attrs.zone_name).toBe("prod-zone");
      expect(attrs.dns_name).toBe("example.com.");
      expect(attrs.visibility).toBe("public");
    });

    it("should handle private visibility", () => {
      const block = { name: "internal", visibility: "private" };
      const attrs = extract(block);
      expect(attrs.visibility).toBe("private");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_apigateway_api
  // -----------------------------------------------------------------------
  describe("google_apigateway_api", () => {
    const extract = gcpExtractors["google_apigateway_api"];

    it("should extract api_id as api_name", () => {
      const attrs = extract({ api_id: "my-api" });
      expect(attrs.api_name).toBe("my-api");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_pubsub_topic
  // -----------------------------------------------------------------------
  describe("google_pubsub_topic", () => {
    const extract = gcpExtractors["google_pubsub_topic"];

    it("should extract topic name", () => {
      const attrs = extract({ name: "order-events" });
      expect(attrs.topic_name).toBe("order-events");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_vertex_ai_endpoint
  // -----------------------------------------------------------------------
  describe("google_vertex_ai_endpoint", () => {
    const extract = gcpExtractors["google_vertex_ai_endpoint"];

    it("should extract endpoint name and machine spec", () => {
      const block = {
        display_name: "prediction-endpoint",
        dedicated_resources: [
          {
            machine_spec: [{ machine_type: "n1-standard-4" }],
            automatic_resources: [{ min_replica_count: 2 }],
          },
        ],
      };
      const attrs = extract(block);
      expect(attrs.endpoint_name).toBe("prediction-endpoint");
      expect(attrs.machine_type).toBe("n1-standard-4");
      expect(attrs.instance_count).toBe(2);
    });

    it("should handle missing dedicated_resources", () => {
      const block = { display_name: "test-endpoint" };
      const attrs = extract(block);
      expect(attrs.endpoint_name).toBe("test-endpoint");
      expect(attrs.machine_type).toBeUndefined();
      expect(attrs.instance_count).toBeUndefined();
    });

    it("should handle dedicated_resources without machine_spec", () => {
      const block = {
        dedicated_resources: [{}],
      };
      const attrs = extract(block);
      expect(attrs.machine_type).toBeUndefined();
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // google_pubsub_subscription
  // -----------------------------------------------------------------------
  describe("google_pubsub_subscription", () => {
    const extract = gcpExtractors["google_pubsub_subscription"];

    it("should extract subscription name and topic", () => {
      const block = {
        name: "order-sub",
        topic: "projects/my-project/topics/order-events",
      };
      const attrs = extract(block);
      expect(attrs.subscription_name).toBe("order-sub");
      expect(attrs.topic).toBe("projects/my-project/topics/order-events");
    });

    it("should return empty for empty block", () => {
      expect(Object.keys(extract({})).length).toBe(0);
    });
  });
});
