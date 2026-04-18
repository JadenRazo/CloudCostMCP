import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Resolve `candidate` relative to `basePath` and assert that the final
 * location stays inside `rootBoundary`. Rejects symlinks that leave the
 * boundary after resolution.
 *
 * Returns the resolved absolute path, or `null` if the path escapes the
 * boundary or traverses a symlink out of it. The caller decides how to
 * surface the rejection (warning + skip vs. hard error).
 *
 * Why: user-supplied HCL can specify `module { source = "../../../etc" }`
 * which — without containment — turns the cost-estimation tool into an
 * arbitrary file-read primitive for anything matching `*.tf` on the host.
 */
export function resolveWithinBoundary(
  candidate: string,
  basePath: string,
  rootBoundary: string,
): string | null {
  const resolved = resolve(basePath, candidate);
  const boundary = resolve(rootBoundary);

  if (!isWithin(resolved, boundary)) return null;

  // If the path exists, follow symlinks and re-check. If it does not exist
  // yet, allow it — the downstream reader will simply find nothing.
  try {
    const real = realpathSync(resolved);
    if (!isWithin(real, boundary)) return null;

    // Reject direct symlinks even if the target is within the boundary —
    // they are a common sandbox-escape primitive and Terraform modules do
    // not need them.
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) return null;

    return real;
  } catch {
    // Path does not exist yet; return the lexically-resolved path and let
    // the caller's existence check handle the miss.
    return resolved;
  }
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}
