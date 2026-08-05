import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../currency.js";
import {
  filePathSchema,
  fileContentSchema,
  tfvarsSchema,
  assertTotalFileBytesWithin,
} from "./bounded.js";

/**
 * Shared schema fragments reused by every MCP tool that accepts IaC input.
 *
 * These exist so that security-relevant limits (per-file size, files-array
 * length, aggregate byte cap) are defined in exactly one place. Before this
 * module, each tool re-declared its own `files` schema and a fix applied to
 * one copy silently missed the other seven.
 */

/** The three cloud providers every tool understands. */
export const providerEnum = z.enum(["aws", "azure", "gcp"]);

/** A single { path, content } IaC file entry with per-field size bounds. */
export const iacFileEntrySchema = z.object({
  path: filePathSchema.describe("File path"),
  content: fileContentSchema.describe("File content"),
});

/**
 * A bounded array of IaC files:
 * - at most 2000 entries,
 * - each entry individually bounded (path length, per-file content bytes),
 * - the *sum* of all content bytes capped by `assertTotalFileBytesWithin`.
 *
 * Tools chain `.describe(...)` / `.optional()` as needed; the checks are
 * preserved through those wrappers.
 */
export const iacFilesSchema = z
  .array(iacFileEntrySchema)
  .max(2000, "files array exceeds 2000 entries")
  .superRefine(assertTotalFileBytesWithin);

/** Optional terraform.tfvars override content, bounded to MAX_TFVARS_BYTES. */
export const tfvarsField = tfvarsSchema.optional().describe("Contents of terraform.tfvars file");

/** Output currency selector shared by cost-reporting tools. */
export const currencyField = z
  .enum(SUPPORTED_CURRENCIES)
  .optional()
  .default("USD")
  .describe("Output currency for cost estimates. Defaults to USD.");
