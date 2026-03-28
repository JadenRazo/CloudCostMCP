import type { CloudProvider } from "../types/index.js";

const PROVIDER_PREFIXES: Array<[string, CloudProvider]> = [
  ["aws_", "aws"],
  ["azurerm_", "azure"],
  ["google_", "gcp"],
];

/**
 * Derive the CloudProvider from a Terraform resource type string by inspecting
 * the well-known provider prefix. Throws when the prefix is not recognised so
 * callers can handle unsupported resource types explicitly.
 */
export function detectProvider(resourceType: string): CloudProvider {
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (resourceType.startsWith(prefix)) {
      return provider;
    }
  }

  throw new Error(
    `Cannot determine cloud provider for resource type "${resourceType}". ` +
      `Supported prefixes: aws_, azurerm_, google_`,
  );
}
