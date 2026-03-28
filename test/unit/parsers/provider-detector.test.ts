import { describe, it, expect } from "vitest";
import { detectProvider } from "../../../src/parsers/provider-detector.js";

describe("provider-detector", () => {
  // -------------------------------------------------------------------------
  // AWS detection
  // -------------------------------------------------------------------------

  it("detects AWS from aws_instance", () => {
    expect(detectProvider("aws_instance")).toBe("aws");
  });

  it("detects AWS from aws_s3_bucket", () => {
    expect(detectProvider("aws_s3_bucket")).toBe("aws");
  });

  it("detects AWS from aws_lambda_function", () => {
    expect(detectProvider("aws_lambda_function")).toBe("aws");
  });

  // -------------------------------------------------------------------------
  // Azure detection
  // -------------------------------------------------------------------------

  it("detects Azure from azurerm_linux_virtual_machine", () => {
    expect(detectProvider("azurerm_linux_virtual_machine")).toBe("azure");
  });

  it("detects Azure from azurerm_storage_account", () => {
    expect(detectProvider("azurerm_storage_account")).toBe("azure");
  });

  it("detects Azure from azurerm_kubernetes_cluster", () => {
    expect(detectProvider("azurerm_kubernetes_cluster")).toBe("azure");
  });

  // -------------------------------------------------------------------------
  // GCP detection
  // -------------------------------------------------------------------------

  it("detects GCP from google_compute_instance", () => {
    expect(detectProvider("google_compute_instance")).toBe("gcp");
  });

  it("detects GCP from google_storage_bucket", () => {
    expect(detectProvider("google_storage_bucket")).toBe("gcp");
  });

  it("detects GCP from google_container_cluster", () => {
    expect(detectProvider("google_container_cluster")).toBe("gcp");
  });

  // -------------------------------------------------------------------------
  // Mixed providers (each call is independent, but verify sequential calls)
  // -------------------------------------------------------------------------

  it("handles mixed provider detection across calls", () => {
    expect(detectProvider("aws_instance")).toBe("aws");
    expect(detectProvider("azurerm_resource_group")).toBe("azure");
    expect(detectProvider("google_compute_disk")).toBe("gcp");
  });

  // -------------------------------------------------------------------------
  // Unknown / unsupported resource types
  // -------------------------------------------------------------------------

  it("throws for an unknown resource type prefix", () => {
    expect(() => detectProvider("digitalocean_droplet")).toThrow(/Cannot determine cloud provider/);
  });

  it("throws for an empty string", () => {
    expect(() => detectProvider("")).toThrow(/Cannot determine cloud provider/);
  });

  it("throws for a resource type with no recognized prefix", () => {
    expect(() => detectProvider("random_pet")).toThrow(/Cannot determine cloud provider/);
  });

  it("includes supported prefixes in the error message", () => {
    expect(() => detectProvider("oci_core_instance")).toThrow(/aws_, azurerm_, google_/);
  });
});
