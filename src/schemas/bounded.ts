import { z } from "zod";

/**
 * Input-size limits applied to user-supplied strings that flow into parsers
 * and JSON deserializers. Kept generous enough for real Terraform monorepos
 * but small enough to block memory-exhaustion DoS from a malicious MCP
 * client or prompt-injection payload.
 */
export const MAX_FILE_PATH_LEN = 1024;
export const MAX_FILE_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MiB per file
export const MAX_TFVARS_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MAX_PLAN_JSON_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_STATE_JSON_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_SHORT_STRING_LEN = 256;
// Aggregate cap across all files in one tool call. Per-file .max() is not
// enough — 2000 × 5 MiB = 10 GiB theoretical. This bounds the *sum*.
export const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB total
// FOCUS (FinOps Open Cost and Usage Specification) billing export caps.
// 10 MiB comfortably fits month-of-line-items exports for real workloads
// while blocking multi-GB dumps being piped through the MCP client.
// The row cap keeps pace with the byte cap at ~200 bytes/row.
export const MAX_FOCUS_EXPORT_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_FOCUS_ROWS = 50000;

export const filePathSchema = z
  .string()
  .max(MAX_FILE_PATH_LEN, `File path exceeds ${MAX_FILE_PATH_LEN} characters`);

export const fileContentSchema = z
  .string()
  .max(MAX_FILE_CONTENT_BYTES, `File content exceeds ${MAX_FILE_CONTENT_BYTES} bytes`);

export const tfvarsSchema = z
  .string()
  .max(MAX_TFVARS_BYTES, `tfvars content exceeds ${MAX_TFVARS_BYTES} bytes`);

export const planJsonSchema = z
  .string()
  .max(MAX_PLAN_JSON_BYTES, `plan JSON exceeds ${MAX_PLAN_JSON_BYTES} bytes`);

export const stateJsonSchema = z
  .string()
  .max(MAX_STATE_JSON_BYTES, `state JSON exceeds ${MAX_STATE_JSON_BYTES} bytes`);

export const shortStringSchema = z
  .string()
  .max(MAX_SHORT_STRING_LEN, `value exceeds ${MAX_SHORT_STRING_LEN} characters`);

/**
 * FOCUS billing export input: either a CSV string (capped by UTF-8 byte length)
 * or a pre-parsed JSON array of row objects (capped by row count). Both caps
 * are enforced at schema validation time so the parser never sees oversized
 * input. `z.string().max(n)` counts UTF-16 code units, not bytes — the refine
 * below measures actual UTF-8 bytes to match `MAX_FOCUS_EXPORT_BYTES`.
 */
export const focusExportSchema = z.union([
  z
    .string()
    .refine(
      (s) => Buffer.byteLength(s, "utf8") <= MAX_FOCUS_EXPORT_BYTES,
      `FOCUS export exceeds ${MAX_FOCUS_EXPORT_BYTES} bytes`,
    ),
  z
    .array(z.record(z.string(), z.unknown()))
    .max(MAX_FOCUS_ROWS, `FOCUS rows exceed ${MAX_FOCUS_ROWS}`),
]);

/**
 * Reject when the sum of all `content` fields exceeds MAX_TOTAL_FILE_BYTES.
 * Applied via `.superRefine` on a `files[]` schema that has already passed
 * per-entry validation.
 */
export function assertTotalFileBytesWithin(
  files: { content: string }[],
  ctx: z.RefinementCtx,
): void {
  let total = 0;
  for (const f of files) {
    total += f.content.length;
    if (total > MAX_TOTAL_FILE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `aggregate file content exceeds ${MAX_TOTAL_FILE_BYTES} bytes`,
        path: ["files"],
      });
      return;
    }
  }
}
