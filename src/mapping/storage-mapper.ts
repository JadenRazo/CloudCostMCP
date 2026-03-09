import type { CloudProvider } from "../types/resources.js";
import { getStorageMap } from "../data/loader.js";
import { logger } from "../logger.js";

/**
 * Maps a storage type identifier from one cloud provider to the equivalent on
 * a target provider.
 *
 * Both block_storage and object_storage sections of the mapping table are
 * checked. Returns null when no match is found.
 */
export function mapStorageType(
  storageType: string,
  sourceProvider: CloudProvider,
  targetProvider: CloudProvider
): string | null {
  if (sourceProvider === targetProvider) return storageType;

  const { block_storage, object_storage } = getStorageMap();

  // Search block storage first, then object storage.
  const allEntries = [...block_storage, ...object_storage];

  const row = allEntries.find(
    (entry) => entry[sourceProvider] === storageType
  );

  if (!row) {
    logger.debug("storage-mapper: no mapping found", {
      storageType,
      sourceProvider,
      targetProvider,
    });
    return null;
  }

  const mapped = row[targetProvider];
  if (!mapped) {
    logger.debug("storage-mapper: target column missing in row", {
      storageType,
      sourceProvider,
      targetProvider,
    });
    return null;
  }

  return mapped;
}
