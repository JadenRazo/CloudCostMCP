import type { CloudProvider, InstanceSpec } from "../types/resources.js";
import {
  getInstanceMap,
  getAwsInstances,
  getAzureVmSizes,
  getGcpMachineTypes,
} from "../data/loader.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Directional key builder
// ---------------------------------------------------------------------------

type DirectionKey =
  | "aws_to_azure"
  | "aws_to_gcp"
  | "azure_to_aws"
  | "azure_to_gcp"
  | "gcp_to_aws"
  | "gcp_to_azure";

function directionKey(source: CloudProvider, target: CloudProvider): DirectionKey | null {
  if (source === target) return null;
  return `${source}_to_${target}` as DirectionKey;
}

// ---------------------------------------------------------------------------
// Spec loaders per provider
// ---------------------------------------------------------------------------

function getSpecsForProvider(provider: CloudProvider): InstanceSpec[] {
  switch (provider) {
    case "aws":
      return getAwsInstances();
    case "azure":
      return getAzureVmSizes();
    case "gcp":
      return getGcpMachineTypes();
  }
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const SCORE_EXACT_VCPU = 40;
const SCORE_APPROX_VCPU = 20;
const SCORE_EXACT_MEMORY = 40;
const SCORE_APPROX_MEMORY = 20;
const SCORE_CATEGORY = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps an instance type from one cloud provider to the closest equivalent on
 * another provider.
 *
 * Strategy:
 *  1. Exact lookup in the pre-computed directional mapping table.
 *  2. Spec-based nearest-instance fallback if no direct mapping exists.
 *
 * Returns null when neither strategy produces a result (e.g. an unsupported
 * instance type with no data file entry).
 */
export function mapInstance(
  instanceType: string,
  sourceProvider: CloudProvider,
  targetProvider: CloudProvider,
): string | null {
  if (sourceProvider === targetProvider) return instanceType;

  const key = directionKey(sourceProvider, targetProvider);
  if (!key) return instanceType;

  // Step 1: exact lookup in the pre-computed table.
  const instanceMap = getInstanceMap();
  const directionalMap = instanceMap[key] as Record<string, string> | undefined;

  if (directionalMap) {
    const exact = directionalMap[instanceType];
    if (exact) {
      logger.debug("instance-mapper: exact match", {
        instanceType,
        sourceProvider,
        targetProvider,
        result: exact,
      });
      return exact;
    }
  }

  // Step 2: spec-based fallback.
  const sourceSpecs = getSpecsForProvider(sourceProvider);
  const sourceSpec = sourceSpecs.find((s) => s.instance_type === instanceType);

  if (!sourceSpec) {
    logger.debug("instance-mapper: source spec not found, cannot map", {
      instanceType,
      sourceProvider,
    });
    return null;
  }

  return findNearestInstance(
    {
      vcpus: sourceSpec.vcpus,
      memory_gb: sourceSpec.memory_gb,
      category: sourceSpec.category,
    },
    targetProvider,
  );
}

/**
 * Finds the closest matching instance type on a target provider given a set
 * of hardware specifications.
 *
 * Scoring rubric (higher is better):
 *   Exact vCPU match:    40 pts
 *   Closest vCPU:        up to 20 pts (scaled by 1 / relative_distance)
 *   Exact memory match:  40 pts
 *   Closest memory:      up to 20 pts (scaled by 1 / relative_distance)
 *   Same category:       20 pts
 */
export function findNearestInstance(
  spec: { vcpus: number; memory_gb: number; category: string },
  targetProvider: CloudProvider,
): string | null {
  const candidates = getSpecsForProvider(targetProvider);

  if (candidates.length === 0) return null;

  let bestScore = -1;
  let bestType: string | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // vCPU scoring
    if (candidate.vcpus === spec.vcpus) {
      score += SCORE_EXACT_VCPU;
    } else {
      // Scaled proximity score: full points when ratio = 1, decays as it diverges.
      const larger = Math.max(candidate.vcpus, spec.vcpus);
      const smaller = Math.min(candidate.vcpus, spec.vcpus);
      if (smaller > 0) {
        score += SCORE_APPROX_VCPU * (smaller / larger);
      }
    }

    // Memory scoring
    if (candidate.memory_gb === spec.memory_gb) {
      score += SCORE_EXACT_MEMORY;
    } else {
      const larger = Math.max(candidate.memory_gb, spec.memory_gb);
      const smaller = Math.min(candidate.memory_gb, spec.memory_gb);
      if (smaller > 0) {
        score += SCORE_APPROX_MEMORY * (smaller / larger);
      }
    }

    // Category bonus
    if (candidate.category === spec.category) {
      score += SCORE_CATEGORY;
    }

    if (
      score > bestScore ||
      (score === bestScore && bestType !== null && candidate.instance_type < bestType)
    ) {
      bestScore = score;
      bestType = candidate.instance_type;
    }
  }

  if (bestType) {
    logger.debug("instance-mapper: nearest match found", {
      spec,
      targetProvider,
      result: bestType,
      score: bestScore,
    });
  }

  return bestType;
}
