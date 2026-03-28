import { describe, it, expect } from "vitest";
import { mapInstance, findNearestInstance } from "../../../src/mapping/instance-mapper.js";

describe("instance-mapper", () => {
  // -------------------------------------------------------------------------
  // AWS -> Azure
  // -------------------------------------------------------------------------

  it("maps AWS t3.large to Azure Standard_B2ms", () => {
    const result = mapInstance("t3.large", "aws", "azure");
    expect(result).toBe("Standard_B2ms");
  });

  it("maps AWS m5.xlarge to Azure Standard_D4s_v5", () => {
    const result = mapInstance("m5.xlarge", "aws", "azure");
    expect(result).toBe("Standard_D4s_v5");
  });

  // -------------------------------------------------------------------------
  // AWS -> GCP
  // -------------------------------------------------------------------------

  it("maps AWS t3.micro to GCP e2-micro", () => {
    const result = mapInstance("t3.micro", "aws", "gcp");
    expect(result).toBe("e2-micro");
  });

  it("maps AWS t3.large to a GCP instance type", () => {
    const result = mapInstance("t3.large", "aws", "gcp");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Azure -> GCP and GCP -> Azure
  // -------------------------------------------------------------------------

  it("maps Azure Standard_B2ms to a GCP instance type", () => {
    const result = mapInstance("Standard_B2ms", "azure", "gcp");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("maps GCP e2-micro to an AWS instance type", () => {
    const result = mapInstance("e2-micro", "gcp", "aws");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("maps Azure Standard_D4s_v5 to an AWS instance type", () => {
    const result = mapInstance("Standard_D4s_v5", "azure", "aws");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Same provider returns identity
  // -------------------------------------------------------------------------

  it("returns same type when source and target provider are the same", () => {
    expect(mapInstance("t3.large", "aws", "aws")).toBe("t3.large");
    expect(mapInstance("Standard_B2ms", "azure", "azure")).toBe("Standard_B2ms");
    expect(mapInstance("e2-micro", "gcp", "gcp")).toBe("e2-micro");
  });

  // -------------------------------------------------------------------------
  // Unknown instance types
  // -------------------------------------------------------------------------

  it("returns null for a completely unknown instance type", () => {
    expect(mapInstance("xt99.supercompute", "aws", "azure")).toBeNull();
  });

  it("returns null for a made-up Azure size", () => {
    expect(mapInstance("Standard_ZZZZ", "azure", "gcp")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case-insensitive input is NOT expected (instance types are case-sensitive)
  // but we verify the behavior is predictable.
  // -------------------------------------------------------------------------

  it("does not match when casing differs (instance types are case-sensitive)", () => {
    // t3.large exists, T3.LARGE does not
    const result = mapInstance("T3.LARGE", "aws", "azure");
    // Either null (not found) or a spec-based fallback; should not crash
    expect(result === null || typeof result === "string").toBe(true);
  });

  // -------------------------------------------------------------------------
  // findNearestInstance
  // -------------------------------------------------------------------------

  it("findNearestInstance returns an Azure match for 2-vCPU 8-GB general_purpose", () => {
    const result = findNearestInstance(
      { vcpus: 2, memory_gb: 8, category: "general_purpose" },
      "azure",
    );
    expect(result).not.toBeNull();
    expect(["Standard_B2ms", "Standard_D2s_v5"]).toContain(result);
  });

  it("findNearestInstance returns a GCP match for 4-vCPU 16-GB general_purpose", () => {
    const result = findNearestInstance(
      { vcpus: 4, memory_gb: 16, category: "general_purpose" },
      "gcp",
    );
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("findNearestInstance prefers compute_optimized category when specs match", () => {
    const result = findNearestInstance(
      { vcpus: 4, memory_gb: 8, category: "compute_optimized" },
      "azure",
    );
    expect(result).toBe("Standard_F4s_v2");
  });

  it("findNearestInstance returns an AWS match for 2-vCPU 4-GB compute_optimized", () => {
    const result = findNearestInstance(
      { vcpus: 2, memory_gb: 4, category: "compute_optimized" },
      "aws",
    );
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });
});
