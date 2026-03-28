import type { ParsedResource } from "../../types/resources.js";
import type { CfnResource } from "./cfn-types.js";

/** Map from CloudFormation resource type to internal Terraform-style type. */
const CFN_TYPE_MAP: Record<string, string> = {
  "AWS::EC2::Instance": "aws_instance",
  "AWS::RDS::DBInstance": "aws_db_instance",
  "AWS::S3::Bucket": "aws_s3_bucket",
  "AWS::EBS::Volume": "aws_ebs_volume",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "aws_lb",
  "AWS::EC2::NatGateway": "aws_nat_gateway",
  "AWS::EKS::Cluster": "aws_eks_cluster",
  "AWS::Lambda::Function": "aws_lambda_function",
  "AWS::DynamoDB::Table": "aws_dynamodb_table",
  "AWS::SQS::Queue": "aws_sqs_queue",
  "AWS::Route53::HostedZone": "aws_route53_zone",
  "AWS::SecretsManager::Secret": "aws_secretsmanager_secret",
  "AWS::ECR::Repository": "aws_ecr_repository",
  "AWS::ElastiCache::CacheCluster": "aws_elasticache_cluster",
  "AWS::CloudFront::Distribution": "aws_cloudfront_distribution",
};

/**
 * Map a single CloudFormation resource to the internal ParsedResource format.
 * Returns null for unsupported resource types (and pushes a warning).
 */
export function mapCfnResource(
  logicalId: string,
  resource: CfnResource,
  region: string,
  filePath: string,
  warnings: string[],
): ParsedResource | null {
  const internalType = CFN_TYPE_MAP[resource.Type];
  if (!internalType) {
    warnings.push(`Unsupported CloudFormation resource type: ${resource.Type} (${logicalId})`);
    return null;
  }

  const props = resource.Properties ?? {};
  const attributes = extractAttributes(resource.Type, props);

  return {
    id: logicalId,
    type: internalType,
    name: logicalId,
    provider: "aws",
    region,
    attributes,
    tags: extractTags(props),
    source_file: filePath,
  };
}

function extractAttributes(
  cfnType: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  switch (cfnType) {
    case "AWS::EC2::Instance":
      return {
        instance_type: asString(props.InstanceType),
        ami: asString(props.ImageId),
      };

    case "AWS::RDS::DBInstance":
      return {
        instance_type: asString(props.DBInstanceClass),
        engine: asString(props.Engine),
        storage_size_gb: asNumber(props.AllocatedStorage),
        multi_az: asBoolean(props.MultiAZ),
      };

    case "AWS::S3::Bucket":
      return {};

    case "AWS::EBS::Volume":
      return {
        storage_type: asString(props.VolumeType),
        storage_size_gb: asNumber(props.Size),
        iops: asNumber(props.Iops),
      };

    case "AWS::ElasticLoadBalancingV2::LoadBalancer":
      return {
        lb_type: asString(props.Type) ?? "application",
      };

    case "AWS::EC2::NatGateway":
      return {};

    case "AWS::EKS::Cluster":
      return {};

    case "AWS::Lambda::Function":
      return {
        memory_size: asNumber(props.MemorySize),
        timeout: asNumber(props.Timeout),
      };

    case "AWS::DynamoDB::Table":
      return {
        billing_mode: asString(props.BillingMode) ?? "PROVISIONED",
        read_capacity: asNumber(
          (props.ProvisionedThroughput as Record<string, unknown> | undefined)?.ReadCapacityUnits,
        ),
        write_capacity: asNumber(
          (props.ProvisionedThroughput as Record<string, unknown> | undefined)?.WriteCapacityUnits,
        ),
      };

    case "AWS::SQS::Queue":
      return {};

    case "AWS::Route53::HostedZone":
      return {};

    case "AWS::SecretsManager::Secret":
      return {};

    case "AWS::ECR::Repository":
      return {};

    case "AWS::ElastiCache::CacheCluster":
      return {
        instance_type: asString(props.CacheNodeType),
        node_count: asNumber(props.NumCacheNodes),
        engine: asString(props.Engine),
      };

    case "AWS::CloudFront::Distribution":
      return {};

    default:
      return {};
  }
}

function extractTags(props: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  const rawTags = props.Tags;
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (tag && typeof tag === "object" && "Key" in tag && "Value" in tag) {
        tags[String(tag.Key)] = String(tag.Value);
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
