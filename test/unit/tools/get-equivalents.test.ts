import { describe, it, expect } from "vitest";
import { getEquivalents } from "../../../src/tools/get-equivalents.js";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// The getEquivalents handler works entirely from bundled data files — no
// network calls, no PricingEngine, no cache. Every test is synchronous-safe
// and deterministic.

describe("getEquivalents", () => {
  // -------------------------------------------------------------------------
  // Resource-type equivalents — all providers
  // -------------------------------------------------------------------------

  it("returns azure and gcp equivalents for aws_instance", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string | null>;
    // The data file maps aws_instance → azurerm_linux_virtual_machine and
    // google_compute_instance.
    expect(equivalents.azure).toBeDefined();
    expect(equivalents.gcp).toBeDefined();
    expect(typeof equivalents.azure).toBe("string");
    expect(typeof equivalents.gcp).toBe("string");
  });

  it("returns aws and gcp equivalents for azurerm_linux_virtual_machine", async () => {
    const result = (await getEquivalents({
      resource_type: "azurerm_linux_virtual_machine",
      source_provider: "azure",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string | null>;
    expect(equivalents.aws).toBeDefined();
    expect(equivalents.gcp).toBeDefined();
  });

  it("returns aws and azure equivalents for google_compute_instance", async () => {
    const result = (await getEquivalents({
      resource_type: "google_compute_instance",
      source_provider: "gcp",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string | null>;
    expect(equivalents.aws).toBeDefined();
    expect(equivalents.azure).toBeDefined();
  });

  it("known aws managed-database equivalents are returned", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_db_instance",
      source_provider: "aws",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string>;
    expect(typeof equivalents.azure).toBe("string");
    expect(typeof equivalents.gcp).toBe("string");
  });

  it("known aws s3 object-storage equivalents are returned", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_s3_bucket",
      source_provider: "aws",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string>;
    expect(equivalents.azure).toBe("azurerm_storage_account");
    expect(equivalents.gcp).toBe("google_storage_bucket");
  });

  // -------------------------------------------------------------------------
  // Resource-type equivalents — single target provider
  // -------------------------------------------------------------------------

  it("returns only the azure equivalent when target_provider is azure", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
      target_provider: "azure",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string | null>;
    expect(Object.keys(equivalents)).toContain("azure");
    expect(Object.keys(equivalents)).not.toContain("gcp");
  });

  it("returns only the gcp equivalent when target_provider is gcp", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
      target_provider: "gcp",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string | null>;
    expect(Object.keys(equivalents)).toContain("gcp");
    expect(Object.keys(equivalents)).not.toContain("azure");
  });

  // -------------------------------------------------------------------------
  // Unknown resource type
  // -------------------------------------------------------------------------

  it("returns an empty resource_equivalents object for an unknown resource type", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_totally_unknown_resource",
      source_provider: "aws",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, unknown>;
    expect(Object.keys(equivalents).length).toBe(0);
  });

  it("does not include null values in resource_equivalents", async () => {
    // Null mappings are filtered out; the resulting object should only contain
    // string values.
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, unknown>;
    for (const value of Object.values(equivalents)) {
      expect(value).not.toBeNull();
      expect(typeof value).toBe("string");
    }
  });

  // -------------------------------------------------------------------------
  // Instance-type equivalents
  // -------------------------------------------------------------------------

  it("includes instance_equivalents when instance_type is provided", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
      instance_type: "t3.medium",
    })) as Record<string, unknown>;

    expect(result).toHaveProperty("instance_type");
    expect(result.instance_type).toBe("t3.medium");
    expect(result).toHaveProperty("instance_equivalents");
  });

  it("instance_equivalents contains results for non-source providers", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
      instance_type: "t3.medium",
    })) as Record<string, unknown>;

    const instanceEquivs = result.instance_equivalents as Record<string, unknown>;
    // aws is the source — we expect azure and/or gcp mappings.
    expect(Object.keys(instanceEquivs)).not.toContain("aws");
    // At least one target provider should have a mapping.
    expect(Object.keys(instanceEquivs).length).toBeGreaterThan(0);
  });

  it("instance_equivalents is scoped to target_provider when both are provided", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
      target_provider: "gcp",
      instance_type: "t3.medium",
    })) as Record<string, unknown>;

    const instanceEquivs = result.instance_equivalents as Record<string, unknown>;
    // Only gcp should appear.
    expect(Object.keys(instanceEquivs).length).toBeLessThanOrEqual(1);
    if (Object.keys(instanceEquivs).length > 0) {
      expect(Object.keys(instanceEquivs)).toContain("gcp");
    }
  });

  it("does not include instance_equivalents when instance_type is omitted", async () => {
    const result = (await getEquivalents({
      resource_type: "aws_instance",
      source_provider: "aws",
    })) as Record<string, unknown>;

    expect(result).not.toHaveProperty("instance_equivalents");
    expect(result).not.toHaveProperty("instance_type");
  });

  // -------------------------------------------------------------------------
  // Cross-provider — azure source
  // -------------------------------------------------------------------------

  it("maps azurerm_kubernetes_cluster to aws and gcp equivalents", async () => {
    const result = (await getEquivalents({
      resource_type: "azurerm_kubernetes_cluster",
      source_provider: "azure",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string>;
    expect(typeof equivalents.aws).toBe("string");
    expect(typeof equivalents.gcp).toBe("string");
  });

  it("maps google_storage_bucket back to aws and azure equivalents", async () => {
    const result = (await getEquivalents({
      resource_type: "google_storage_bucket",
      source_provider: "gcp",
    })) as Record<string, unknown>;

    const equivalents = result.resource_equivalents as Record<string, string>;
    expect(equivalents.aws).toBe("aws_s3_bucket");
    expect(equivalents.azure).toBe("azurerm_storage_account");
  });
});
