import { describe, it, expect } from "vitest";
import { mapRegion } from "../../../src/mapping/region-mapper.js";

describe("region-mapper", () => {
  // -------------------------------------------------------------------------
  // AWS -> Azure
  // -------------------------------------------------------------------------

  it("maps us-east-1 to Azure eastus", () => {
    expect(mapRegion("us-east-1", "aws", "azure")).toBe("eastus");
  });

  it("maps eu-west-1 to Azure northeurope", () => {
    expect(mapRegion("eu-west-1", "aws", "azure")).toBe("northeurope");
  });

  it("maps us-west-2 to an Azure region", () => {
    const result = mapRegion("us-west-2", "aws", "azure");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // AWS -> GCP
  // -------------------------------------------------------------------------

  it("maps us-east-1 to GCP us-east1", () => {
    expect(mapRegion("us-east-1", "aws", "gcp")).toBe("us-east1");
  });

  it("maps ap-southeast-1 to GCP asia-southeast1", () => {
    expect(mapRegion("ap-southeast-1", "aws", "gcp")).toBe("asia-southeast1");
  });

  it("maps eu-west-1 to a GCP region", () => {
    const result = mapRegion("eu-west-1", "aws", "gcp");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Azure -> AWS, Azure -> GCP
  // -------------------------------------------------------------------------

  it("maps Azure eastus to an AWS region", () => {
    const result = mapRegion("eastus", "azure", "aws");
    expect(result).toBe("us-east-1");
  });

  it("maps Azure eastus to a GCP region", () => {
    const result = mapRegion("eastus", "azure", "gcp");
    expect(result).toBe("us-east1");
  });

  // -------------------------------------------------------------------------
  // GCP -> AWS, GCP -> Azure
  // -------------------------------------------------------------------------

  it("maps GCP us-east1 to an AWS region", () => {
    const result = mapRegion("us-east1", "gcp", "aws");
    expect(result).toBe("us-east-1");
  });

  it("maps GCP us-east1 to an Azure region", () => {
    const result = mapRegion("us-east1", "gcp", "azure");
    expect(result).toBe("eastus");
  });

  // -------------------------------------------------------------------------
  // Same provider returns identity
  // -------------------------------------------------------------------------

  it("returns the same region when source and target provider match", () => {
    expect(mapRegion("us-east-1", "aws", "aws")).toBe("us-east-1");
    expect(mapRegion("eastus", "azure", "azure")).toBe("eastus");
    expect(mapRegion("us-central1", "gcp", "gcp")).toBe("us-central1");
  });

  // -------------------------------------------------------------------------
  // Unknown / unmapped regions fall back to defaults
  // -------------------------------------------------------------------------

  it("returns Azure default (eastus) for an unknown AWS region", () => {
    expect(mapRegion("us-gov-west-1", "aws", "azure")).toBe("eastus");
  });

  it("returns GCP default (us-central1) for an unknown AWS region", () => {
    expect(mapRegion("cn-north-1", "aws", "gcp")).toBe("us-central1");
  });

  it("returns AWS default (us-east-1) for an unknown Azure region", () => {
    expect(mapRegion("brazilsouth999", "azure", "aws")).toBe("us-east-1");
  });

  it("returns GCP default (us-central1) for an unknown Azure region", () => {
    expect(mapRegion("unknownregion", "azure", "gcp")).toBe("us-central1");
  });
});
