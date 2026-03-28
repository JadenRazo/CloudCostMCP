import { describe, it, expect } from "vitest";
import { mapStorageType } from "../../../src/mapping/storage-mapper.js";

describe("storage-mapper", () => {
  // -------------------------------------------------------------------------
  // AWS EBS types -> Azure
  // -------------------------------------------------------------------------

  it("maps gp2 to Azure Premium_LRS", () => {
    const result = mapStorageType("gp2", "aws", "azure");
    expect(result).toBe("Premium_LRS");
  });

  it("maps gp3 to Azure Premium_LRS", () => {
    const result = mapStorageType("gp3", "aws", "azure");
    expect(result).toBe("Premium_LRS");
  });

  it("maps io1 to Azure UltraSSD_LRS", () => {
    const result = mapStorageType("io1", "aws", "azure");
    expect(result).toBe("UltraSSD_LRS");
  });

  it("maps io2 to Azure UltraSSD_LRS", () => {
    const result = mapStorageType("io2", "aws", "azure");
    expect(result).toBe("UltraSSD_LRS");
  });

  it("maps st1 to Azure Standard_LRS", () => {
    const result = mapStorageType("st1", "aws", "azure");
    expect(result).toBe("Standard_LRS");
  });

  // -------------------------------------------------------------------------
  // AWS EBS types -> GCP
  // -------------------------------------------------------------------------

  it("maps gp3 to GCP pd-ssd", () => {
    const result = mapStorageType("gp3", "aws", "gcp");
    expect(result).toBe("pd-ssd");
  });

  it("maps st1 to GCP pd-standard", () => {
    const result = mapStorageType("st1", "aws", "gcp");
    expect(result).toBe("pd-standard");
  });

  // -------------------------------------------------------------------------
  // AWS object storage -> Azure and GCP
  // -------------------------------------------------------------------------

  it("maps STANDARD to Azure Hot", () => {
    const result = mapStorageType("STANDARD", "aws", "azure");
    expect(result).toBe("Hot");
  });

  it("maps GLACIER to GCP ARCHIVE", () => {
    const result = mapStorageType("GLACIER", "aws", "gcp");
    expect(result).toBe("ARCHIVE");
  });

  // -------------------------------------------------------------------------
  // Cross-provider: Azure -> GCP, GCP -> AWS
  // -------------------------------------------------------------------------

  it("maps Azure Premium_LRS to GCP pd-ssd", () => {
    const result = mapStorageType("Premium_LRS", "azure", "gcp");
    expect(result).toBe("pd-ssd");
  });

  it("maps GCP pd-ssd to AWS gp3", () => {
    const result = mapStorageType("pd-ssd", "gcp", "aws");
    expect(result).toBe("gp3");
  });

  it("maps Azure Standard_LRS to AWS st1", () => {
    const result = mapStorageType("Standard_LRS", "azure", "aws");
    expect(result).toBe("st1");
  });

  // -------------------------------------------------------------------------
  // Same provider returns identity
  // -------------------------------------------------------------------------

  it("returns same type when source and target provider match", () => {
    expect(mapStorageType("gp3", "aws", "aws")).toBe("gp3");
    expect(mapStorageType("Premium_LRS", "azure", "azure")).toBe("Premium_LRS");
    expect(mapStorageType("pd-ssd", "gcp", "gcp")).toBe("pd-ssd");
  });

  // -------------------------------------------------------------------------
  // Unknown storage types
  // -------------------------------------------------------------------------

  it("returns null for an unknown storage type", () => {
    expect(mapStorageType("quantum-ssd", "aws", "azure")).toBeNull();
  });

  it("returns null for an empty string storage type", () => {
    expect(mapStorageType("", "aws", "azure")).toBeNull();
  });

  it("returns null for a nonsense Azure type targeting GCP", () => {
    expect(mapStorageType("SuperDuper_LRS", "azure", "gcp")).toBeNull();
  });
});
