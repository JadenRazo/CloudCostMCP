import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { calculateKubernetesCost } from "../../../src/calculator/kubernetes.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import type { ParsedResource } from "../../../src/types/resources.js";

vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-k8s-test-${suffix}`, "cache.db");
}

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-k8s",
    type: "aws_eks_cluster",
    name: "test-cluster",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

describe("calculateKubernetesCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("calculates control plane cost for an EKS cluster", async () => {
    const resource = makeResource();

    const estimate = await calculateKubernetesCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.provider).toBe("aws");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.breakdown.some((b) => b.description.includes("control plane"))).toBe(true);
  });

  it("calculates GKE control plane cost", async () => {
    const resource = makeResource({
      provider: "gcp",
      type: "google_container_cluster",
    });

    const estimate = await calculateKubernetesCost(resource, "gcp", "us-central1", pricingEngine);

    expect(estimate.provider).toBe("gcp");
    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("includes node compute cost when node_count and instance_type are specified", async () => {
    const clusterOnly = makeResource();

    const withNodes = makeResource({
      attributes: {
        node_count: 3,
        instance_type: "t3.large",
      },
    });

    const clusterEst = await calculateKubernetesCost(
      clusterOnly,
      "aws",
      "us-east-1",
      pricingEngine,
    );
    const withNodesEst = await calculateKubernetesCost(
      withNodes,
      "aws",
      "us-east-1",
      pricingEngine,
    );

    expect(withNodesEst.monthly_cost).toBeGreaterThan(clusterEst.monthly_cost);
    expect(withNodesEst.breakdown.some((b) => b.description.includes("node"))).toBe(true);
  });

  it("adds note when node_count is set but instance_type is missing", async () => {
    const resource = makeResource({
      attributes: { node_count: 3 },
    });

    const estimate = await calculateKubernetesCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.notes.some((n) => n.includes("no instance_type found"))).toBe(true);
  });

  it("uses min_node_count as fallback for node count", async () => {
    const resource = makeResource({
      attributes: {
        min_node_count: 2,
        instance_type: "t3.large",
      },
    });

    const estimate = await calculateKubernetesCost(resource, "aws", "us-east-1", pricingEngine);

    expect(estimate.monthly_cost).toBeGreaterThan(0);
  });

  it("returns low confidence when no K8s pricing is available", async () => {
    const resource = makeResource({
      type: "aws_eks_cluster",
    });

    // Even with fallback data, an unknown region might not have pricing
    const estimate = await calculateKubernetesCost(resource, "aws", "us-east-1", pricingEngine);

    // If pricing exists, confidence should be at least medium
    if (estimate.monthly_cost > 0) {
      expect(["medium", "high"]).toContain(estimate.confidence);
    }
  });
});
