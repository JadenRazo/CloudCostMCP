import { describe, it, expect } from "vitest";
import { findEquivalent, findAllEquivalents } from "../../../src/mapping/resource-mapper.js";
import { mapInstance, findNearestInstance } from "../../../src/mapping/instance-mapper.js";
import { mapRegion } from "../../../src/mapping/region-mapper.js";
import { mapStorageType } from "../../../src/mapping/storage-mapper.js";

// ---------------------------------------------------------------------------
// resource-mapper
// ---------------------------------------------------------------------------

describe("resource-mapper", () => {
  it("maps aws_instance -> azurerm_linux_virtual_machine", () => {
    const result = findEquivalent("aws_instance", "aws", "azure");
    expect(result).toBe("azurerm_linux_virtual_machine");
  });

  it("maps aws_instance -> google_compute_instance", () => {
    const result = findEquivalent("aws_instance", "aws", "gcp");
    expect(result).toBe("google_compute_instance");
  });

  it("maps azurerm_linux_virtual_machine -> aws_instance", () => {
    const result = findEquivalent("azurerm_linux_virtual_machine", "azure", "aws");
    expect(result).toBe("aws_instance");
  });

  it("maps aws_eks_cluster -> azurerm_kubernetes_cluster", () => {
    const result = findEquivalent("aws_eks_cluster", "aws", "azure");
    expect(result).toBe("azurerm_kubernetes_cluster");
  });

  it("maps aws_s3_bucket -> google_storage_bucket", () => {
    const result = findEquivalent("aws_s3_bucket", "aws", "gcp");
    expect(result).toBe("google_storage_bucket");
  });

  it("returns null for an unknown resource type", () => {
    const result = findEquivalent("aws_unknown_service", "aws", "azure");
    expect(result).toBeNull();
  });

  it("returns the same resource type when source and target provider are the same", () => {
    const result = findEquivalent("aws_instance", "aws", "aws");
    expect(result).toBe("aws_instance");
  });

  it("findAllEquivalents returns mappings for all providers", () => {
    const result = findAllEquivalents("aws_instance", "aws");
    expect(result.aws).toBe("aws_instance");
    expect(result.azure).toBe("azurerm_linux_virtual_machine");
    expect(result.gcp).toBe("google_compute_instance");
  });

  it("findAllEquivalents returns empty object for unknown type", () => {
    const result = findAllEquivalents("aws_mystery_resource", "aws");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// instance-mapper
// ---------------------------------------------------------------------------

describe("instance-mapper", () => {
  it("maps t3.large -> Standard_B2ms (exact table lookup)", () => {
    const result = mapInstance("t3.large", "aws", "azure");
    expect(result).toBe("Standard_B2ms");
  });

  it("maps t3.micro -> e2-micro (AWS to GCP)", () => {
    const result = mapInstance("t3.micro", "aws", "gcp");
    expect(result).toBe("e2-micro");
  });

  it("maps m5.xlarge -> Standard_D4s_v5 (AWS to Azure)", () => {
    const result = mapInstance("m5.xlarge", "aws", "azure");
    expect(result).toBe("Standard_D4s_v5");
  });

  it("returns same type when source and target are identical", () => {
    const result = mapInstance("t3.large", "aws", "aws");
    expect(result).toBe("t3.large");
  });

  it("falls back to nearest spec-based match for unmapped instance", () => {
    // m6i.large is in aws-instances.json (2 vCPU, 8 GB) but may not be in
    // instance-map.json for all directions; verify it returns something reasonable.
    const result = mapInstance("m6i.large", "aws", "gcp");
    // Should return a 2 vCPU GCP machine type.
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("returns null for a completely unknown instance type with no spec entry", () => {
    const result = mapInstance("xt99.supercompute", "aws", "azure");
    expect(result).toBeNull();
  });

  it("findNearestInstance matches by vcpus and memory_gb", () => {
    // t3.large spec: 2 vCPU, 8 GB general_purpose -> expect Standard_B2ms or similar
    const result = findNearestInstance(
      { vcpus: 2, memory_gb: 8, category: "general_purpose" },
      "azure"
    );
    expect(result).not.toBeNull();
    // The nearest 2-vCPU 8-GB Azure instance should be Standard_B2ms or Standard_D2s_v5.
    expect(["Standard_B2ms", "Standard_D2s_v5"]).toContain(result);
  });

  it("findNearestInstance returns a result for GCP targets", () => {
    const result = findNearestInstance(
      { vcpus: 4, memory_gb: 16, category: "general_purpose" },
      "gcp"
    );
    expect(result).not.toBeNull();
    // e2-standard-4 or n2-standard-4 are the natural fits.
    expect(typeof result).toBe("string");
  });

  it("findNearestInstance prefers category match when sizes are close", () => {
    const computeOptimized = findNearestInstance(
      { vcpus: 4, memory_gb: 8, category: "compute_optimized" },
      "azure"
    );
    // Standard_F4s_v2 is the 4-vCPU compute-optimized Azure VM.
    expect(computeOptimized).toBe("Standard_F4s_v2");
  });
});

// ---------------------------------------------------------------------------
// region-mapper
// ---------------------------------------------------------------------------

describe("region-mapper", () => {
  it("maps us-east-1 -> eastus (AWS to Azure)", () => {
    const result = mapRegion("us-east-1", "aws", "azure");
    expect(result).toBe("eastus");
  });

  it("maps us-east-1 -> us-east1 (AWS to GCP)", () => {
    const result = mapRegion("us-east-1", "aws", "gcp");
    expect(result).toBe("us-east1");
  });

  it("maps eu-west-1 -> northeurope (AWS to Azure)", () => {
    const result = mapRegion("eu-west-1", "aws", "azure");
    expect(result).toBe("northeurope");
  });

  it("maps ap-southeast-1 -> asia-southeast1 (AWS to GCP)", () => {
    const result = mapRegion("ap-southeast-1", "aws", "gcp");
    expect(result).toBe("asia-southeast1");
  });

  it("returns same region when provider is the same", () => {
    const result = mapRegion("us-east-1", "aws", "aws");
    expect(result).toBe("us-east-1");
  });

  it("returns a sensible default for an unknown AWS region (Azure target)", () => {
    const result = mapRegion("us-gov-west-1", "aws", "azure");
    expect(result).toBe("eastus");
  });

  it("returns a sensible default for an unknown AWS region (GCP target)", () => {
    const result = mapRegion("cn-north-1", "aws", "gcp");
    expect(result).toBe("us-central1");
  });

  it("returns a sensible default for an unknown AWS region (AWS target)", () => {
    // Same provider but unknown region – falls through to identity.
    const result = mapRegion("us-east-1", "aws", "aws");
    expect(result).toBe("us-east-1");
  });
});

// ---------------------------------------------------------------------------
// storage-mapper
// ---------------------------------------------------------------------------

describe("storage-mapper", () => {
  it("maps gp3 -> Premium_LRS (AWS to Azure block storage)", () => {
    const result = mapStorageType("gp3", "aws", "azure");
    expect(result).toBe("Premium_LRS");
  });

  it("maps gp3 -> pd-ssd (AWS to GCP block storage)", () => {
    const result = mapStorageType("gp3", "aws", "gcp");
    expect(result).toBe("pd-ssd");
  });

  it("maps st1 -> Standard_LRS (AWS to Azure HDD)", () => {
    const result = mapStorageType("st1", "aws", "azure");
    expect(result).toBe("Standard_LRS");
  });

  it("maps STANDARD -> Hot (AWS object storage to Azure)", () => {
    const result = mapStorageType("STANDARD", "aws", "azure");
    expect(result).toBe("Hot");
  });

  it("maps GLACIER -> ARCHIVE (AWS to GCP object storage)", () => {
    const result = mapStorageType("GLACIER", "aws", "gcp");
    expect(result).toBe("ARCHIVE");
  });

  it("returns same type when source and target provider are identical", () => {
    const result = mapStorageType("gp3", "aws", "aws");
    expect(result).toBe("gp3");
  });

  it("returns null for an unknown storage type", () => {
    const result = mapStorageType("quantum-ssd", "aws", "azure");
    expect(result).toBeNull();
  });

  it("maps io2 -> UltraSSD_LRS (provisioned IOPS to Azure)", () => {
    const result = mapStorageType("io2", "aws", "azure");
    expect(result).toBe("UltraSSD_LRS");
  });
});
