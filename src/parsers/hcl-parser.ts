import { parse } from "@cdktf/hcl2json";
import { logger } from "../logger.js";
import { sanitizeForMessage } from "../util/sanitize.js";

/**
 * Convert raw HCL content into a plain JavaScript object using the
 * @cdktf/hcl2json WASM-backed parser. The filename parameter is used only for
 * error reporting and diagnostics inside the parser; it does not need to be an
 * actual path on disk. Both .tf (Terraform) and .tofu (OpenTofu) extensions
 * use identical HCL syntax and are parsed without any special handling.
 *
 * The returned shape mirrors the Terraform HCL block structure:
 *   {
 *     provider: { aws: [{ region: "us-east-1" }] },
 *     resource: { aws_instance: { name: [{ instance_type: "t3.micro", ... }] } },
 *     variable: { region: [{ default: "us-east-1" }] },
 *     ...
 *   }
 */
export async function parseHclToJson(
  hclContent: string,
  filename = "main.tf",
): Promise<Record<string, unknown>> {
  if (!hclContent.trim()) {
    logger.debug("Received empty HCL content, returning empty object", {
      filename,
    });
    return {};
  }

  try {
    const result = await parse(filename, hclContent);
    logger.debug("Parsed HCL successfully", { filename });
    return result as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const safeFilename = sanitizeForMessage(filename, 256);
    const safeMessage = sanitizeForMessage(message, 512);

    logger.error("Failed to parse HCL", { filename: safeFilename, error: safeMessage });

    throw new Error(`HCL parse error in "${safeFilename}": ${safeMessage}`);
  }
}
