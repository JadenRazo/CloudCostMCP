import { describe, it, expect } from "vitest";
import { GcpBundledLoader } from "../../../src/pricing/gcp/bundled-loader.js";

describe("GcpBundledLoader", () => {
  // GcpBundledLoader has no external dependencies and needs no cache – it
  // reads directly from the bundled JSON data files.
  const loader = new GcpBundledLoader();

  // -------------------------------------------------------------------------
  // Compute Engine
  // -------------------------------------------------------------------------

  it("returns price for e2-micro in us-central1", async () => {
    const result = await loader.getComputePrice("e2-micro", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("compute-engine");
    expect(result!.resource_type).toBe("e2-micro");
    expect(result!.region).toBe("us-central1");
    expect(result!.unit).toBe("h");
    expect(result!.currency).toBe("USD");
    // Bundled data: e2-micro us-central1 = 0.0084
    expect(result!.price_per_unit).toBeCloseTo(0.0084, 4);
  });

  it("returns price for n2-standard-4 in us-central1", async () => {
    const result = await loader.getComputePrice("n2-standard-4", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.1942, 4);
  });

  it("returns price for e2-micro in europe-west1 (higher rate)", async () => {
    const usResult = await loader.getComputePrice("e2-micro", "us-central1");
    const euResult = await loader.getComputePrice("e2-micro", "europe-west1");

    expect(usResult).not.toBeNull();
    expect(euResult).not.toBeNull();
    // European pricing is higher than US
    expect(euResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
  });

  it("returns null for an unknown machine type", async () => {
    const result = await loader.getComputePrice("z99-quantum-8", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null for an unknown region", async () => {
    const result = await loader.getComputePrice("e2-micro", "us-fictional-9");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cloud SQL
  // -------------------------------------------------------------------------

  it("returns price for db-custom-2-7680 in us-central1", async () => {
    const result = await loader.getDatabasePrice(
      "db-custom-2-7680",
      "us-central1"
    );

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-sql");
    expect(result!.resource_type).toBe("db-custom-2-7680");
    expect(result!.unit).toBe("h");
    // Bundled data: db-custom-2-7680 us-central1 = 0.1000
    expect(result!.price_per_unit).toBeCloseTo(0.1000, 4);
  });

  it("returns price for db-custom-4-15360 in europe-west1", async () => {
    const result = await loader.getDatabasePrice(
      "db-custom-4-15360",
      "europe-west1"
    );

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.2200, 4);
  });

  it("does not expose storage_per_gb as a database tier", async () => {
    const result = await loader.getDatabasePrice(
      "storage_per_gb",
      "us-central1"
    );
    expect(result).toBeNull();
  });

  it("does not expose ha_multiplier as a database tier", async () => {
    const result = await loader.getDatabasePrice(
      "ha_multiplier",
      "us-central1"
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown SQL tier", async () => {
    const result = await loader.getDatabasePrice(
      "db-turbo-9999",
      "us-central1"
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown region", async () => {
    const result = await loader.getDatabasePrice(
      "db-custom-2-7680",
      "mars-west1"
    );
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cloud Storage
  // -------------------------------------------------------------------------

  it("returns price for STANDARD class in us-central1", async () => {
    const result = await loader.getStoragePrice("STANDARD", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-storage");
    expect(result!.resource_type).toBe("STANDARD");
    expect(result!.unit).toBe("GiBy.mo");
    // Bundled data: STANDARD us-central1 = 0.020
    expect(result!.price_per_unit).toBeCloseTo(0.020, 4);
  });

  it("returns price for NEARLINE class", async () => {
    const result = await loader.getStoragePrice("NEARLINE", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.010, 4);
  });

  it("returns price for COLDLINE class", async () => {
    const result = await loader.getStoragePrice("COLDLINE", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.004, 4);
  });

  it("normalises storage class name to uppercase", async () => {
    const upper = await loader.getStoragePrice("STANDARD", "us-central1");
    const lower = await loader.getStoragePrice("standard", "us-central1");

    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(lower!.price_per_unit).toBe(upper!.price_per_unit);
  });

  it("returns higher price for asia-southeast1 STANDARD storage", async () => {
    const usResult = await loader.getStoragePrice("STANDARD", "us-central1");
    const apResult = await loader.getStoragePrice("STANDARD", "asia-southeast1");

    expect(usResult).not.toBeNull();
    expect(apResult).not.toBeNull();
    expect(apResult!.price_per_unit).toBeGreaterThan(usResult!.price_per_unit);
  });

  it("returns null for unknown storage class", async () => {
    const result = await loader.getStoragePrice("SUPERSONIC", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null for unknown storage region", async () => {
    const result = await loader.getStoragePrice("STANDARD", "moon-south1");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Persistent Disk
  // -------------------------------------------------------------------------

  it("returns price for pd-ssd in us-central1", async () => {
    const result = await loader.getDiskPrice("pd-ssd", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("persistent-disk");
    expect(result!.resource_type).toBe("pd-ssd");
    expect(result!.unit).toBe("GiBy.mo");
    // Bundled data: pd-ssd us-central1 = 0.170
    expect(result!.price_per_unit).toBeCloseTo(0.170, 4);
  });

  it("returns price for pd-standard", async () => {
    const result = await loader.getDiskPrice("pd-standard", "us-central1");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.040, 4);
  });

  it("returns null for unknown disk type", async () => {
    const result = await loader.getDiskPrice("pd-quantum", "us-central1");
    expect(result).toBeNull();
  });

  it("returns null for unknown disk region", async () => {
    const result = await loader.getDiskPrice("pd-ssd", "neptune-east1");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Infrastructure services (LB, NAT, GKE)
  // -------------------------------------------------------------------------

  it("returns GCP Load Balancer price", async () => {
    const result = await loader.getLoadBalancerPrice("us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-load-balancing");
    expect(result!.price_per_unit).toBeCloseTo(0.025, 4);
    expect(result!.attributes.per_gb_price).toBe("0.008");
  });

  it("returns GCP Cloud NAT price", async () => {
    const result = await loader.getNatGatewayPrice("us-central1");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("cloud-nat");
    expect(result!.price_per_unit).toBeCloseTo(0.044, 4);
  });

  it("returns GKE Standard cluster price", async () => {
    const result = await loader.getKubernetesPrice("us-central1", "standard");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gcp");
    expect(result!.service).toBe("gke");
    expect(result!.price_per_unit).toBeCloseTo(0.10, 4);
    expect(result!.attributes.mode).toBe("standard");
  });

  it("returns GKE Autopilot cluster with per-vCPU/hr price estimate", async () => {
    const result = await loader.getKubernetesPrice("us-central1", "autopilot");

    expect(result).not.toBeNull();
    expect(result!.price_per_unit).toBeCloseTo(0.0445, 4);
    expect(result!.attributes.mode).toBe("autopilot");
    expect(result!.attributes.pricing_model).toBe("per_vcpu_hour");
  });
});
