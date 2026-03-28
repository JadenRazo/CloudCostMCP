import type { CloudProvider, ParsedResource } from "../../types/resources.js";
import type { PulumiResource } from "./pulumi-types.js";

/** Map from Pulumi resource type to { internal type, provider }. */
const PULUMI_TYPE_MAP: Record<string, { type: string; provider: CloudProvider }> = {
  // AWS
  "aws:ec2/instance:Instance": { type: "aws_instance", provider: "aws" },
  "aws:rds/instance:Instance": { type: "aws_db_instance", provider: "aws" },
  "aws:s3/bucket:Bucket": { type: "aws_s3_bucket", provider: "aws" },
  "aws:ebs/volume:Volume": { type: "aws_ebs_volume", provider: "aws" },
  "aws:lb/loadBalancer:LoadBalancer": { type: "aws_lb", provider: "aws" },
  "aws:ec2/natGateway:NatGateway": { type: "aws_nat_gateway", provider: "aws" },
  "aws:eks/cluster:Cluster": { type: "aws_eks_cluster", provider: "aws" },
  "aws:lambda/function:Function": { type: "aws_lambda_function", provider: "aws" },
  "aws:dynamodb/table:Table": { type: "aws_dynamodb_table", provider: "aws" },
  "aws:route53/zone:Zone": { type: "aws_route53_zone", provider: "aws" },
  "aws:ecr/repository:Repository": { type: "aws_ecr_repository", provider: "aws" },
  "aws:secretsmanager/secret:Secret": { type: "aws_secretsmanager_secret", provider: "aws" },

  // Azure
  "azure:compute:VirtualMachine": { type: "azurerm_linux_virtual_machine", provider: "azure" },
  "azure:containerservice:KubernetesCluster": {
    type: "azurerm_kubernetes_cluster",
    provider: "azure",
  },
  "azure:sql:Database": { type: "azurerm_mssql_server", provider: "azure" },
  "azure:storage:Account": { type: "azurerm_storage_account", provider: "azure" },
  "azure:keyvault:KeyVault": { type: "azurerm_key_vault", provider: "azure" },
  "azure:dns:Zone": { type: "azurerm_dns_zone", provider: "azure" },

  // GCP
  "gcp:compute:Instance": { type: "google_compute_instance", provider: "gcp" },
  "gcp:sql:DatabaseInstance": { type: "google_sql_database_instance", provider: "gcp" },
  "gcp:storage:Bucket": { type: "google_storage_bucket", provider: "gcp" },
  "gcp:container:Cluster": { type: "google_container_cluster", provider: "gcp" },
  "gcp:cloudfunctions:Function": { type: "google_cloudfunctions_function", provider: "gcp" },
  "gcp:dns:ManagedZone": { type: "google_dns_managed_zone", provider: "gcp" },
};

/**
 * Map a single Pulumi resource to the internal ParsedResource format.
 * Returns null for unsupported or internal resource types (and pushes a warning).
 */
export function mapPulumiResource(
  resource: PulumiResource,
  warnings: string[],
): ParsedResource | null {
  const mapping = PULUMI_TYPE_MAP[resource.type];
  if (!mapping) {
    warnings.push(`Unsupported Pulumi resource type: ${resource.type}`);
    return null;
  }

  const name = extractNameFromUrn(resource.urn);
  const merged = mergeInputsOutputs(resource);
  const region = extractRegion(merged, mapping.provider);
  const attributes = extractAttributes(resource.type, merged);
  const tags = extractTags(merged);

  return {
    id: resource.id ?? name,
    type: mapping.type,
    name,
    provider: mapping.provider,
    region,
    attributes,
    tags,
    source_file: "pulumi-state",
  };
}

/**
 * Extract the logical resource name from a Pulumi URN.
 * URN format: urn:pulumi:<stack>::<project>::<type>::<name>
 */
function extractNameFromUrn(urn: string): string {
  const parts = urn.split("::");
  return parts.length >= 4 ? parts[3] : urn;
}

/**
 * Merge inputs and outputs, preferring outputs (which reflect actual state).
 */
function mergeInputsOutputs(resource: PulumiResource): Record<string, unknown> {
  return { ...(resource.inputs ?? {}), ...(resource.outputs ?? {}) };
}

/**
 * Extract the region from resource properties. For AWS, the availability zone
 * (e.g. "us-east-1a") is trimmed to derive the region ("us-east-1"). For Azure
 * and GCP, the location/zone field is used directly.
 */
function extractRegion(props: Record<string, unknown>, provider: CloudProvider): string {
  const DEFAULTS: Record<CloudProvider, string> = {
    aws: "us-east-1",
    azure: "eastus",
    gcp: "us-central1",
  };

  if (provider === "aws") {
    const az = asString(props.availabilityZone);
    if (az) {
      // Strip trailing letter(s) from AZ to get region: "us-east-1a" -> "us-east-1"
      return az.replace(/[a-z]+$/, "");
    }
    const region = asString(props.region);
    if (region) return region;
  }

  if (provider === "azure") {
    const location = asString(props.location);
    if (location) return location;
  }

  if (provider === "gcp") {
    const zone = asString(props.zone);
    if (zone) {
      // Strip trailing "-a"/"-b"/etc: "us-central1-a" -> "us-central1"
      return zone.replace(/-[a-z]$/, "");
    }
    const region = asString(props.region);
    if (region) return region;
  }

  return DEFAULTS[provider];
}

/**
 * Extract resource attributes, mapping Pulumi camelCase properties to
 * internal snake_case names.
 */
function extractAttributes(
  pulumiType: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  switch (pulumiType) {
    case "aws:ec2/instance:Instance":
      return {
        instance_type: asString(props.instanceType),
        ami: asString(props.ami),
      };

    case "aws:rds/instance:Instance":
      return {
        instance_type: asString(props.instanceClass),
        engine: asString(props.engine),
        storage_size_gb: asNumber(props.allocatedStorage),
        multi_az: asBoolean(props.multiAz),
      };

    case "aws:s3/bucket:Bucket":
      return {};

    case "aws:ebs/volume:Volume":
      return {
        storage_type: asString(props.type),
        storage_size_gb: asNumber(props.size),
        iops: asNumber(props.iops),
      };

    case "aws:lb/loadBalancer:LoadBalancer":
      return {
        lb_type: asString(props.loadBalancerType) ?? "application",
      };

    case "aws:ec2/natGateway:NatGateway":
      return {};

    case "aws:eks/cluster:Cluster":
      return {};

    case "aws:lambda/function:Function":
      return {
        memory_size: asNumber(props.memorySize),
        timeout: asNumber(props.timeout),
      };

    case "aws:dynamodb/table:Table":
      return {
        billing_mode: asString(props.billingMode) ?? "PROVISIONED",
        read_capacity: asNumber(props.readCapacity),
        write_capacity: asNumber(props.writeCapacity),
      };

    case "aws:route53/zone:Zone":
      return {};

    case "aws:ecr/repository:Repository":
      return {};

    case "aws:secretsmanager/secret:Secret":
      return {};

    // Azure
    case "azure:compute:VirtualMachine":
      return {
        vm_size: asString(props.vmSize),
      };

    case "azure:containerservice:KubernetesCluster":
      return {};

    case "azure:sql:Database":
      return {
        engine: "mssql",
      };

    case "azure:storage:Account":
      return {
        tier: asString(props.accountTier),
        storage_type: asString(props.accountReplicationType),
      };

    case "azure:keyvault:KeyVault":
      return {
        sku: asString(props.skuName),
      };

    case "azure:dns:Zone":
      return {};

    // GCP
    case "gcp:compute:Instance":
      return {
        machine_type: asString(props.machineType),
      };

    case "gcp:sql:DatabaseInstance":
      return {
        engine: asString(props.databaseVersion),
        tier: asString((props.settings as Record<string, unknown> | undefined)?.tier),
      };

    case "gcp:storage:Bucket":
      return {
        storage_type: asString(props.storageClass),
      };

    case "gcp:container:Cluster":
      return {
        node_count: asNumber(props.initialNodeCount),
      };

    case "gcp:cloudfunctions:Function":
      return {
        memory_size: asNumber(props.availableMemoryMb),
        timeout: asNumber(props.timeout),
      };

    case "gcp:dns:ManagedZone":
      return {};

    default:
      return {};
  }
}

/**
 * Extract tags from the merged properties. Pulumi uses a flat "tags" object
 * (same as Terraform) for AWS and GCP. Azure uses a similar "tags" property.
 */
function extractTags(props: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  const raw = props.tags;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        tags[key] = value;
      }
    }
  }
  return tags;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
