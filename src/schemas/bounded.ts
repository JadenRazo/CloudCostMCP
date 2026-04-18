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
