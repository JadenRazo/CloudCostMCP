/**
 * Shared price interpolation utilities used across AWS and Azure pricing modules.
 *
 * Two interpolation strategies are provided:
 *
 * 1. `interpolateByVcpuRatio` — Azure-style linear scaling.
 *    Extracts an embedded numeric value (vCPU count) from the resource name,
 *    finds the nearest known entry in the same family, and scales the price
 *    proportionally. Suitable for any resource family where price scales
 *    linearly with the embedded count (VMs, DB tiers).
 *
 * 2. `interpolateByStepOrder` — AWS-style doubling by step position.
 *    Looks up the target size name in a fixed ordered list, finds the nearest
 *    known size in the same family, then scales by 2^(step difference).
 *    Matches the AWS EC2/RDS size progression: nano→micro→small→…→48xlarge.
 */

/**
 * Normalise a resource name key for lookup: lowercase, collapse whitespace and
 * hyphens to underscores.
 */
function normaliseKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
}

/**
 * Azure / linear-ratio interpolation.
 *
 * Splits the resource name on the first embedded integer sequence to get a
 * `prefix`, a `num`, and a `suffix`. Searches `table` for the entry with the
 * same prefix and suffix but the closest `num`, then scales its price by
 * `targetNum / bestNum`.
 *
 * @param resourceName  The resource identifier to interpolate a price for
 *                      (e.g. "Standard_D6s_v5" or "gp_standard_d6s_v3").
 * @param table         Map of known resource names → prices.
 * @param keyNormaliser Optional function to normalise `resourceName` before
 *                      matching. Defaults to lowercasing and replacing
 *                      whitespace/hyphens with underscores.
 * @returns The interpolated price, or `undefined` if no suitable base entry
 *          could be found.
 */
export function interpolateByVcpuRatio(
  resourceName: string,
  table: Record<string, number>,
  keyNormaliser: (name: string) => string = normaliseKey,
): number | undefined {
  const key = keyNormaliser(resourceName);

  // Split on the first run of digits: "standard_d2s_v5" → ["standard_d", "2", "s_v5"]
  const match = key.match(/^(.+?)(\d+)(.*?)$/);
  if (!match) return undefined;

  const [, prefix, numStr, suffix] = match;
  const targetNum = parseInt(numStr, 10);
  if (isNaN(targetNum) || targetNum === 0) return undefined;

  let bestKey: string | undefined;
  let bestNum = 0;
  let bestDistance = Infinity;

  for (const candidate of Object.keys(table)) {
    const candMatch = candidate.match(/^(.+?)(\d+)(.*?)$/);
    if (!candMatch) continue;
    const [, cPrefix, cNumStr, cSuffix] = candMatch;
    if (cPrefix !== prefix || cSuffix !== suffix) continue;

    const cNum = parseInt(cNumStr, 10);
    if (isNaN(cNum) || cNum === 0) continue;

    const distance = Math.abs(cNum - targetNum);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNum = cNum;
      bestKey = candidate;
    }
  }

  if (bestKey === undefined || bestNum === 0) return undefined;
  return table[bestKey]! * (targetNum / bestNum);
}

/**
 * AWS / step-order (doubling) interpolation.
 *
 * Looks up `requestedType` in `sizeOrder` to get its step index, finds the
 * nearest known entry in `table` belonging to the same family, then scales by
 * `2^(targetIndex - knownIndex)`.  Each step in the order represents a
 * doubling of resources (and therefore price).
 *
 * @param requestedType  The full instance type string (e.g. "m5.6xlarge",
 *                       "db.r6g.16xlarge").
 * @param table          Map of known instance types → prices.
 * @param sizeOrder      Ordered list of size name suffixes from smallest to
 *                       largest (e.g. ["nano","micro","small",…,"48xlarge"]).
 * @returns The interpolated price, or `undefined` if no suitable base entry
 *          could be found.
 */
export function interpolateByStepOrder(
  requestedType: string,
  table: Record<string, number>,
  sizeOrder: readonly string[],
): number | undefined {
  const lower = requestedType.toLowerCase();
  // Split on the last dot: "m5.2xlarge" → family "m5", size "2xlarge"
  // Also handles "db.r6g.xlarge" → family "db.r6g", size "xlarge"
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) return undefined;

  const family = lower.slice(0, lastDot);
  const targetSize = lower.slice(lastDot + 1);

  const targetIdx = sizeOrder.indexOf(targetSize);
  if (targetIdx === -1) return undefined;

  let bestKey: string | undefined;
  let bestIdx = -1;
  let bestDistance = Infinity;

  for (const key of Object.keys(table)) {
    const keyLastDot = key.lastIndexOf(".");
    if (keyLastDot === -1) continue;
    const keyFamily = key.slice(0, keyLastDot);
    const keySize = key.slice(keyLastDot + 1);
    if (keyFamily !== family) continue;

    const keyIdx = sizeOrder.indexOf(keySize);
    if (keyIdx === -1) continue;

    const distance = Math.abs(keyIdx - targetIdx);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIdx = keyIdx;
      bestKey = key;
    }
  }

  if (bestKey === undefined || bestIdx === -1) return undefined;

  const knownPrice = table[bestKey]!;
  const steps = targetIdx - bestIdx;
  // Each step doubles (positive = bigger instance, negative = smaller)
  return knownPrice * Math.pow(2, steps);
}
