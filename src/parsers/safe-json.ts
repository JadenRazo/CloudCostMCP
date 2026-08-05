/**
 * JSON.parse wrapper that rejects keys which enable prototype pollution.
 *
 * Why: the plan_json and state_json tool inputs are user-controlled strings
 * that get parsed and then handed to code that deep-merges or iterates the
 * result. A malicious payload with `__proto__`, `constructor`, or `prototype`
 * keys at any depth can poison Object.prototype and affect unrelated requests.
 *
 * The reviver runs bottom-up: returning `undefined` causes the key to be
 * omitted from the output object.
 */
import { logger } from "../logger.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function safeJsonParse<T = unknown>(text: string): T {
  let droppedKeys = 0;
  const parsed = JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) {
      droppedKeys++;
      return undefined;
    }
    return value;
  }) as T;
  if (droppedKeys > 0) {
    // One warning per parse (not per key): dropped keys usually indicate a
    // crafted payload, and the caller's output silently differs from input.
    logger.warn("safeJsonParse: dropped prototype-pollution keys from payload", {
      droppedKeys,
    });
  }
  return parsed;
}

/**
 * Recursively strip forbidden keys from an already-parsed object. Use this
 * when the data came from a parser we don't control (e.g., HCL-to-JSON) and
 * may re-introduce `__proto__` as an own-property via its reviver-free path.
 */
export function stripForbiddenKeys<T>(value: T): T {
  const counter = { dropped: 0 };
  const result = stripForbiddenKeysInner(value, counter);
  if (counter.dropped > 0) {
    logger.warn("stripForbiddenKeys: dropped prototype-pollution keys from object", {
      droppedKeys: counter.dropped,
    });
  }
  return result;
}

function stripForbiddenKeysInner<T>(value: T, counter: { dropped: number }): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripForbiddenKeysInner(v, counter)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) {
      counter.dropped++;
      continue;
    }
    out[k] = stripForbiddenKeysInner(v, counter);
  }
  return out as T;
}
