import type { ResourceAttributes } from "../../types/index.js";

export type AttributeExtractor = (block: Record<string, unknown>) => ResourceAttributes;

/**
 * Attempt to read a nested block list and return the first element, or an
 * empty object when the structure is absent.
 */
export function firstBlock(block: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = block[key];
  if (Array.isArray(nested) && nested.length > 0) {
    return nested[0] as Record<string, unknown>;
  }
  return {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
