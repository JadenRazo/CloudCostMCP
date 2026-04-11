import { describe, it, expect, beforeEach } from "vitest";
import {
  getResourceEquivalents,
  getInstanceMap,
  getRegionMappings,
  getStorageMap,
  getAwsInstances,
  getAzureVmSizes,
  getGcpMachineTypes,
  getGcpComputePricing,
  getGcpSqlPricing,
  getGcpStoragePricing,
  getGcpDiskPricing,
  _resetLoaderCache,
} from "../../../src/data/loader.js";

// Reset the module-level cache before each test so that each test exercises
// a cold load and the assertions are independent of execution order.
beforeEach(() => {
  _resetLoaderCache();
});

// ---------------------------------------------------------------------------
// resource-equivalents.json
// ---------------------------------------------------------------------------

describe("resource-equivalents.json", () => {
  it("loads without error and returns a non-empty array", () => {
    const data = getResourceEquivalents();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has required fields: category, aws, azure, gcp", () => {
    for (const entry of getResourceEquivalents()) {
      expect(typeof entry.category).toBe("string");
      expect(entry.category.length).toBeGreaterThan(0);
      expect(typeof entry.aws).toBe("string");
      expect(entry.aws.length).toBeGreaterThan(0);
      expect(typeof entry.azure).toBe("string");
      expect(entry.azure.length).toBeGreaterThan(0);
      expect(typeof entry.gcp).toBe("string");
      expect(entry.gcp.length).toBeGreaterThan(0);
    }
  });

  it("contains the expected categories", () => {
    const categories = getResourceEquivalents().map((e) => e.category);
    const expected = [
      "compute_instance",
      "object_storage",
      "block_storage",
      "kubernetes_cluster",
      "managed_database_postgres",
      "redis_cache",
    ];
    for (const cat of expected) {
      expect(categories).toContain(cat);
    }
  });

  it("returns the same reference on repeated calls (lazy singleton)", () => {
    const first = getResourceEquivalents();
    const second = getResourceEquivalents();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// instance-map.json
// ---------------------------------------------------------------------------

describe("instance-map.json", () => {
  it("loads without error", () => {
    expect(() => getInstanceMap()).not.toThrow();
  });

  it("contains all six directional mapping keys", () => {
    const map = getInstanceMap();
    const requiredKeys = [
      "aws_to_azure",
      "aws_to_gcp",
      "azure_to_aws",
      "azure_to_gcp",
      "gcp_to_aws",
      "gcp_to_azure",
    ];
    for (const key of requiredKeys) {
      expect(map).toHaveProperty(key);
    }
  });

  it("each directional map is a non-empty object with string values", () => {
    const map = getInstanceMap();
    const directions = [
      map.aws_to_azure,
      map.aws_to_gcp,
      map.azure_to_aws,
      map.azure_to_gcp,
      map.gcp_to_aws,
      map.gcp_to_azure,
    ] as const;

    for (const direction of directions) {
      const entries = Object.entries(direction);
      expect(entries.length).toBeGreaterThan(0);
      for (const [source, target] of entries) {
        expect(typeof source).toBe("string");
        expect(typeof target).toBe("string");
        expect(target.length).toBeGreaterThan(0);
      }
    }
  });

  it("known aws_to_azure mappings resolve correctly", () => {
    const map = getInstanceMap();
    expect(map.aws_to_azure["t3.micro"]).toBe("Standard_B1s");
    expect(map.aws_to_azure["m5.large"]).toBe("Standard_D2s_v5");
    expect(map.aws_to_azure["r5.xlarge"]).toBe("Standard_E4s_v5");
  });

  it("known aws_to_gcp mappings resolve correctly", () => {
    const map = getInstanceMap();
    expect(map.aws_to_gcp["t3.micro"]).toBe("e2-micro");
    expect(map.aws_to_gcp["c5.large"]).toBe("c2-standard-4");
  });

  it("known gcp_to_aws mappings resolve correctly", () => {
    const map = getInstanceMap();
    expect(map.gcp_to_aws["e2-micro"]).toBe("t3.micro");
    expect(map.gcp_to_aws["n2-standard-2"]).toBe("m5.large");
  });
});

// ---------------------------------------------------------------------------
// region-mappings.json
// ---------------------------------------------------------------------------

describe("region-mappings.json", () => {
  it("loads without error and returns a non-empty array", () => {
    const data = getRegionMappings();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has required fields: aws, azure, gcp, display_name", () => {
    for (const entry of getRegionMappings()) {
      expect(typeof entry.aws).toBe("string");
      expect(entry.aws.length).toBeGreaterThan(0);
      expect(typeof entry.azure).toBe("string");
      expect(entry.azure.length).toBeGreaterThan(0);
      expect(typeof entry.gcp).toBe("string");
      expect(entry.gcp.length).toBeGreaterThan(0);
      expect(typeof entry.display_name).toBe("string");
      expect(entry.display_name.length).toBeGreaterThan(0);
    }
  });

  it("contains core AWS regions", () => {
    const awsRegions = getRegionMappings().map((r) => r.aws);
    expect(awsRegions).toContain("us-east-1");
    expect(awsRegions).toContain("us-west-2");
    expect(awsRegions).toContain("eu-west-1");
    expect(awsRegions).toContain("ap-southeast-1");
  });

  it("us-east-1 maps to the expected azure and gcp counterparts", () => {
    const usEast = getRegionMappings().find((r) => r.aws === "us-east-1");
    expect(usEast).toBeDefined();
    expect(usEast?.azure).toBe("eastus");
    expect(usEast?.gcp).toBe("us-east1");
  });
});

// ---------------------------------------------------------------------------
// storage-map.json
// ---------------------------------------------------------------------------

describe("storage-map.json", () => {
  it("loads without error", () => {
    expect(() => getStorageMap()).not.toThrow();
  });

  it("has block_storage and object_storage top-level keys", () => {
    const map = getStorageMap();
    expect(Array.isArray(map.block_storage)).toBe(true);
    expect(Array.isArray(map.object_storage)).toBe(true);
  });

  it("each block_storage entry has category, aws, azure, gcp", () => {
    for (const entry of getStorageMap().block_storage) {
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.aws).toBe("string");
      expect(typeof entry.azure).toBe("string");
      expect(typeof entry.gcp).toBe("string");
    }
  });

  it("each object_storage entry has category, aws, azure, gcp", () => {
    for (const entry of getStorageMap().object_storage) {
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.aws).toBe("string");
      expect(typeof entry.azure).toBe("string");
      expect(typeof entry.gcp).toBe("string");
    }
  });

  it("block_storage contains ssd_general with correct iops_baseline", () => {
    const ssdGeneral = getStorageMap().block_storage.find((e) => e.category === "ssd_general");
    expect(ssdGeneral).toBeDefined();
    expect(ssdGeneral?.iops_baseline).toBe(3000);
    expect(ssdGeneral?.aws).toBe("gp3");
  });
});

// ---------------------------------------------------------------------------
// AWS instance types
// ---------------------------------------------------------------------------

describe("aws-instances.json", () => {
  it("loads without error and returns a non-empty array", () => {
    const data = getAwsInstances();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has provider, instance_type, vcpus, memory_gb, category", () => {
    for (const spec of getAwsInstances()) {
      expect(spec.provider).toBe("aws");
      expect(typeof spec.instance_type).toBe("string");
      expect(spec.instance_type.length).toBeGreaterThan(0);
      expect(typeof spec.vcpus).toBe("number");
      expect(spec.vcpus).toBeGreaterThan(0);
      expect(typeof spec.memory_gb).toBe("number");
      expect(spec.memory_gb).toBeGreaterThan(0);
      expect(typeof spec.category).toBe("string");
      expect(spec.category.length).toBeGreaterThan(0);
    }
  });

  it("contains at least 20 entries", () => {
    expect(getAwsInstances().length).toBeGreaterThanOrEqual(20);
  });

  it("t3.micro has the expected spec values", () => {
    const t3micro = getAwsInstances().find((s) => s.instance_type === "t3.micro");
    expect(t3micro).toBeDefined();
    expect(t3micro?.vcpus).toBe(2);
    expect(t3micro?.memory_gb).toBe(1);
    expect(t3micro?.category).toBe("general_purpose");
  });

  it("includes both compute and database instance categories", () => {
    const categories = new Set(getAwsInstances().map((s) => s.category));
    expect(categories.has("general_purpose")).toBe(true);
    expect(categories.has("compute_optimized")).toBe(true);
    expect(categories.has("memory_optimized")).toBe(true);
    expect(categories.has("database")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Azure VM sizes
// ---------------------------------------------------------------------------

describe("azure-vm-sizes.json", () => {
  it("loads without error and returns a non-empty array", () => {
    const data = getAzureVmSizes();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has provider set to azure with required fields", () => {
    for (const spec of getAzureVmSizes()) {
      expect(spec.provider).toBe("azure");
      expect(typeof spec.instance_type).toBe("string");
      expect(spec.instance_type.length).toBeGreaterThan(0);
      expect(typeof spec.vcpus).toBe("number");
      expect(spec.vcpus).toBeGreaterThan(0);
      expect(typeof spec.memory_gb).toBe("number");
      expect(spec.memory_gb).toBeGreaterThan(0);
      expect(typeof spec.category).toBe("string");
    }
  });

  it("Standard_D2s_v5 has the expected spec values", () => {
    const spec = getAzureVmSizes().find((s) => s.instance_type === "Standard_D2s_v5");
    expect(spec).toBeDefined();
    expect(spec?.vcpus).toBe(2);
    expect(spec?.memory_gb).toBe(8);
    expect(spec?.category).toBe("general_purpose");
  });
});

// ---------------------------------------------------------------------------
// GCP machine types
// ---------------------------------------------------------------------------

describe("gcp-machine-types.json", () => {
  it("loads without error and returns a non-empty array", () => {
    const data = getGcpMachineTypes();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has provider set to gcp with required fields", () => {
    for (const spec of getGcpMachineTypes()) {
      expect(spec.provider).toBe("gcp");
      expect(typeof spec.instance_type).toBe("string");
      expect(spec.instance_type.length).toBeGreaterThan(0);
      expect(typeof spec.vcpus).toBe("number");
      expect(spec.vcpus).toBeGreaterThan(0);
      expect(typeof spec.memory_gb).toBe("number");
      expect(spec.memory_gb).toBeGreaterThan(0);
      expect(typeof spec.category).toBe("string");
    }
  });

  it("e2-micro has fractional vcpu and correct memory", () => {
    const spec = getGcpMachineTypes().find((s) => s.instance_type === "e2-micro");
    expect(spec).toBeDefined();
    expect(spec?.vcpus).toBe(0.25);
    expect(spec?.memory_gb).toBe(1);
  });

  it("includes database category entries", () => {
    const dbEntries = getGcpMachineTypes().filter((s) => s.category === "database");
    expect(dbEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GCP pricing files – shared region consistency
// ---------------------------------------------------------------------------

describe("GCP pricing files – region consistency", () => {
  const CORE_REGIONS = ["us-central1", "us-east1", "europe-west1", "asia-southeast1"];

  it("compute-engine.json covers all core regions", () => {
    const pricing = getGcpComputePricing();
    for (const region of CORE_REGIONS) {
      expect(pricing).toHaveProperty(region);
    }
  });

  it("cloud-storage.json covers all core regions", () => {
    const pricing = getGcpStoragePricing();
    for (const region of CORE_REGIONS) {
      expect(pricing).toHaveProperty(region);
    }
  });

  it("persistent-disk.json covers all core regions", () => {
    const pricing = getGcpDiskPricing();
    for (const region of CORE_REGIONS) {
      expect(pricing).toHaveProperty(region);
    }
  });

  it("cloud-sql.json covers us-central1, us-east1, europe-west1", () => {
    const pricing = getGcpSqlPricing();
    for (const region of ["us-central1", "us-east1", "europe-west1"]) {
      expect(pricing).toHaveProperty(region);
    }
  });
});

// ---------------------------------------------------------------------------
// GCP Compute Engine pricing
// ---------------------------------------------------------------------------

describe("GCP compute-engine.json", () => {
  it("loads without error and returns a non-empty object", () => {
    const data = getGcpComputePricing();
    expect(typeof data).toBe("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it("every region entry contains numeric prices for each machine type", () => {
    for (const [region, types] of Object.entries(getGcpComputePricing())) {
      expect(Object.keys(types).length).toBeGreaterThan(0);
      for (const [machineType, price] of Object.entries(types)) {
        expect(typeof price).toBe("number");
        expect(price).toBeGreaterThan(0);
        // Basic sanity: hourly price should be realistic (< $100)
        expect(price).toBeLessThan(100);
        void region;
        void machineType;
      }
    }
  });

  it("us-central1 e2-micro price is 0.0084 per hour", () => {
    expect(getGcpComputePricing()["us-central1"]["e2-micro"]).toBe(0.0084);
  });
});

// ---------------------------------------------------------------------------
// GCP Cloud SQL pricing
// ---------------------------------------------------------------------------

describe("GCP cloud-sql.json", () => {
  it("loads without error", () => {
    expect(() => getGcpSqlPricing()).not.toThrow();
  });

  it("us-central1 contains tier pricing and metadata keys", () => {
    const region = getGcpSqlPricing()["us-central1"];
    expect(region).toBeDefined();
    expect(region["db-custom-1-3840"]).toBe(0.0515);
    expect(region["storage_per_gb"]).toBe(0.17);
    expect(region["ha_multiplier"]).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// GCP Cloud Storage pricing
// ---------------------------------------------------------------------------

describe("GCP cloud-storage.json", () => {
  it("loads without error", () => {
    expect(() => getGcpStoragePricing()).not.toThrow();
  });

  it("each region entry has STANDARD, NEARLINE, COLDLINE, ARCHIVE keys with numeric values", () => {
    for (const [, tiers] of Object.entries(getGcpStoragePricing())) {
      expect(typeof tiers.STANDARD).toBe("number");
      expect(typeof tiers.NEARLINE).toBe("number");
      expect(typeof tiers.COLDLINE).toBe("number");
      expect(typeof tiers.ARCHIVE).toBe("number");
    }
  });

  it("asia-southeast1 STANDARD is more expensive than us-central1", () => {
    const pricing = getGcpStoragePricing();
    expect(pricing["asia-southeast1"].STANDARD).toBeGreaterThan(pricing["us-central1"].STANDARD);
  });
});

// ---------------------------------------------------------------------------
// GCP Persistent Disk pricing
// ---------------------------------------------------------------------------

describe("GCP persistent-disk.json", () => {
  it("loads without error", () => {
    expect(() => getGcpDiskPricing()).not.toThrow();
  });

  it("each region entry has pd-standard, pd-ssd, pd-balanced with numeric values", () => {
    for (const [, disks] of Object.entries(getGcpDiskPricing())) {
      expect(typeof disks["pd-standard"]).toBe("number");
      expect(typeof disks["pd-ssd"]).toBe("number");
      expect(typeof disks["pd-balanced"]).toBe("number");
    }
  });

  it("pd-ssd is more expensive than pd-standard in every region", () => {
    for (const [, disks] of Object.entries(getGcpDiskPricing())) {
      expect(disks["pd-ssd"]).toBeGreaterThan(disks["pd-standard"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Loader – type integrity across all functions
// ---------------------------------------------------------------------------

describe("loader – return type integrity", () => {
  it("getResourceEquivalents returns an array", () => {
    expect(Array.isArray(getResourceEquivalents())).toBe(true);
  });

  it("getInstanceMap returns an object with all six keys", () => {
    const m = getInstanceMap();
    expect(typeof m).toBe("object");
    expect(Object.keys(m)).toHaveLength(6);
  });

  it("getRegionMappings returns an array", () => {
    expect(Array.isArray(getRegionMappings())).toBe(true);
  });

  it("getStorageMap returns an object with block_storage and object_storage", () => {
    const m = getStorageMap();
    expect(typeof m).toBe("object");
    expect(Array.isArray(m.block_storage)).toBe(true);
    expect(Array.isArray(m.object_storage)).toBe(true);
  });

  it("getAwsInstances returns a non-empty array", () => {
    const data = getAwsInstances();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("getAzureVmSizes returns a non-empty array", () => {
    const data = getAzureVmSizes();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("getGcpMachineTypes returns a non-empty array", () => {
    const data = getGcpMachineTypes();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("getGcpComputePricing returns a non-empty object", () => {
    const data = getGcpComputePricing();
    expect(typeof data).toBe("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it("getGcpSqlPricing returns a non-empty object", () => {
    const data = getGcpSqlPricing();
    expect(typeof data).toBe("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it("getGcpStoragePricing returns a non-empty object", () => {
    const data = getGcpStoragePricing();
    expect(typeof data).toBe("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it("getGcpDiskPricing returns a non-empty object", () => {
    const data = getGcpDiskPricing();
    expect(typeof data).toBe("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });
});
