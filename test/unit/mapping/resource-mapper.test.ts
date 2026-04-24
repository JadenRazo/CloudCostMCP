import { describe, it, expect } from "vitest";
import { findEquivalent, findAllEquivalents } from "../../../src/mapping/resource-mapper.js";

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
