import type { CloudProvider } from "../types/resources.js";
import type { ResourceEquivalent } from "../types/mapping.js";
import { getResourceEquivalents } from "../data/loader.js";

/**
 * Finds the equivalent resource type on a target provider for a given
 * resource type on a source provider.
 *
 * The lookup is bidirectional: the source provider column is searched for an
 * exact match against resourceType, and the target provider column value is
 * returned. Returns null when no mapping exists.
 */
export function findEquivalent(
  resourceType: string,
  sourceProvider: CloudProvider,
  targetProvider: CloudProvider,
): string | null {
  if (sourceProvider === targetProvider) {
    return resourceType;
  }

  const equivalents = getResourceEquivalents();
  const row = equivalents.find((entry) => entry[sourceProvider] === resourceType);

  if (!row) return null;
  return row[targetProvider] ?? null;
}

/**
 * Returns a mapping of all known equivalent resource types across every
 * provider for a given source resource type. Providers that have no
 * equivalent are omitted from the result.
 */
export function findAllEquivalents(
  resourceType: string,
  sourceProvider: CloudProvider,
): Record<CloudProvider, string> {
  const equivalents = getResourceEquivalents();
  const row = equivalents.find((entry) => entry[sourceProvider] === resourceType);

  if (!row) return {} as Record<CloudProvider, string>;

  const result: Partial<Record<CloudProvider, string>> = {};
  const providers: CloudProvider[] = ["aws", "azure", "gcp"];

  for (const provider of providers) {
    const value = (row as ResourceEquivalent)[provider];
    if (value) {
      result[provider] = value;
    }
  }

  return result as Record<CloudProvider, string>;
}
