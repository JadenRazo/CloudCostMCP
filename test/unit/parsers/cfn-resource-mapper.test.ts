import { describe, it, expect } from "vitest";
import { mapCfnResource } from "../../../src/parsers/cloudformation/cfn-resource-mapper.js";
import type { CfnResource } from "../../../src/parsers/cloudformation/cfn-types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resource(type: string, props: Record<string, unknown> = {}): CfnResource {
  return { Type: type, Properties: props };
}

// ---------------------------------------------------------------------------
// Unsupported type
// ---------------------------------------------------------------------------

describe("mapCfnResource — unsupported types", () => {
  it("returns null and pushes a warning for an unknown type", () => {
    const warnings: string[] = [];
    const result = mapCfnResource(
      "MyFoo",
      resource("AWS::Unknown::Resource"),
      "us-east-1",
      "template.yaml",
      warnings,
    );
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unsupported CloudFormation resource type");
    expect(warnings[0]).toContain("MyFoo");
  });
});

// ---------------------------------------------------------------------------
// Core fields
// ---------------------------------------------------------------------------

describe("mapCfnResource — core field mapping", () => {
  it("sets id / name / provider / region / source_file correctly", () => {
    const warnings: string[] = [];
    const result = mapCfnResource(
      "WebServer",
      resource("AWS::EC2::Instance", { InstanceType: "t3.small", ImageId: "ami-abc" }),
      "eu-west-1",
      "path/to/template.yaml",
      warnings,
    );

    expect(result!.id).toBe("WebServer");
    expect(result!.name).toBe("WebServer");
    expect(result!.provider).toBe("aws");
    expect(result!.region).toBe("eu-west-1");
    expect(result!.source_file).toBe("path/to/template.yaml");
  });

  it("handles a resource with no Properties block", () => {
    const warnings: string[] = [];
    const result = mapCfnResource(
      "Empty",
      { Type: "AWS::S3::Bucket" } as CfnResource,
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(result!.type).toBe("aws_s3_bucket");
    expect(result!.attributes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Attribute extraction per resource type
// ---------------------------------------------------------------------------

describe("mapCfnResource — per-type attribute extraction", () => {
  it("maps AWS::EC2::Instance → instance_type + ami", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", { InstanceType: "m5.large", ImageId: "ami-xxx" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.instance_type).toBe("m5.large");
    expect(r!.attributes.ami).toBe("ami-xxx");
  });

  it("maps AWS::RDS::DBInstance fields (class/engine/storage/multi-az)", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "DB",
      resource("AWS::RDS::DBInstance", {
        DBInstanceClass: "db.t3.medium",
        Engine: "postgres",
        AllocatedStorage: 100,
        MultiAZ: true,
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.instance_type).toBe("db.t3.medium");
    expect(r!.attributes.engine).toBe("postgres");
    expect(r!.attributes.storage_size_gb).toBe(100);
    expect(r!.attributes.multi_az).toBe(true);
  });

  it("coerces numeric strings in AWS::RDS::DBInstance AllocatedStorage", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "DB",
      resource("AWS::RDS::DBInstance", { AllocatedStorage: "200" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.storage_size_gb).toBe(200);
  });

  it("coerces 'true' / 'false' strings to booleans", () => {
    const warnings: string[] = [];
    const tTrue = mapCfnResource(
      "DB",
      resource("AWS::RDS::DBInstance", { MultiAZ: "true" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    const tFalse = mapCfnResource(
      "DB",
      resource("AWS::RDS::DBInstance", { MultiAZ: "false" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(tTrue!.attributes.multi_az).toBe(true);
    expect(tFalse!.attributes.multi_az).toBe(false);
  });

  it("drops non-'true'/'false' string MultiAZ values", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "DB",
      resource("AWS::RDS::DBInstance", { MultiAZ: "yes" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.multi_az).toBeUndefined();
  });

  it("maps AWS::EBS::Volume fields", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Disk",
      resource("AWS::EBS::Volume", { VolumeType: "gp3", Size: 100, Iops: 3000 }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.type).toBe("aws_ebs_volume");
    expect(r!.attributes.storage_type).toBe("gp3");
    expect(r!.attributes.storage_size_gb).toBe(100);
    expect(r!.attributes.iops).toBe(3000);
  });

  it("defaults lb_type to 'application' when Type is missing", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "LB",
      resource("AWS::ElasticLoadBalancingV2::LoadBalancer", {}),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.lb_type).toBe("application");
  });

  it("uses provided lb_type when Type is set", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "NLB",
      resource("AWS::ElasticLoadBalancingV2::LoadBalancer", { Type: "network" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.lb_type).toBe("network");
  });

  it("maps AWS::Lambda::Function memory + timeout", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Fn",
      resource("AWS::Lambda::Function", { MemorySize: 256, Timeout: 30 }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.memory_size).toBe(256);
    expect(r!.attributes.timeout).toBe(30);
  });

  it("maps AWS::DynamoDB::Table with default PROVISIONED billing", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Tbl",
      resource("AWS::DynamoDB::Table", {
        ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 5 },
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.billing_mode).toBe("PROVISIONED");
    expect(r!.attributes.read_capacity).toBe(10);
    expect(r!.attributes.write_capacity).toBe(5);
  });

  it("maps AWS::DynamoDB::Table with explicit PAY_PER_REQUEST billing", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Tbl",
      resource("AWS::DynamoDB::Table", { BillingMode: "PAY_PER_REQUEST" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.billing_mode).toBe("PAY_PER_REQUEST");
    expect(r!.attributes.read_capacity).toBeUndefined();
  });

  it("handles missing ProvisionedThroughput for DynamoDB", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Tbl",
      resource("AWS::DynamoDB::Table", {}),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.read_capacity).toBeUndefined();
    expect(r!.attributes.write_capacity).toBeUndefined();
  });

  it("maps AWS::ElastiCache::CacheCluster attributes", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Cache",
      resource("AWS::ElastiCache::CacheCluster", {
        CacheNodeType: "cache.r5.large",
        NumCacheNodes: 3,
        Engine: "redis",
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.type).toBe("aws_elasticache_cluster");
    expect(r!.attributes.instance_type).toBe("cache.r5.large");
    expect(r!.attributes.node_count).toBe(3);
    expect(r!.attributes.engine).toBe("redis");
  });

  it.each([
    ["AWS::S3::Bucket", "aws_s3_bucket"],
    ["AWS::EC2::NatGateway", "aws_nat_gateway"],
    ["AWS::EKS::Cluster", "aws_eks_cluster"],
    ["AWS::SQS::Queue", "aws_sqs_queue"],
    ["AWS::Route53::HostedZone", "aws_route53_zone"],
    ["AWS::SecretsManager::Secret", "aws_secretsmanager_secret"],
    ["AWS::ECR::Repository", "aws_ecr_repository"],
    ["AWS::CloudFront::Distribution", "aws_cloudfront_distribution"],
  ])("maps %s to %s with empty attributes", (cfn, internal) => {
    const warnings: string[] = [];
    const r = mapCfnResource("R", resource(cfn), "us-east-1", "t.yaml", warnings);
    expect(r!.type).toBe(internal);
    expect(r!.attributes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

describe("mapCfnResource — tag extraction", () => {
  it("converts the CFN Tags array into a Record<string, string>", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", {
        InstanceType: "t3.small",
        Tags: [
          { Key: "Env", Value: "prod" },
          { Key: "Owner", Value: "team-x" },
        ],
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.tags).toEqual({ Env: "prod", Owner: "team-x" });
  });

  it("stringifies non-string Tag Values", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", {
        Tags: [{ Key: "Count", Value: 42 }],
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.tags).toEqual({ Count: "42" });
  });

  it("ignores malformed tag entries that lack Key or Value", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", {
        Tags: [{ Key: "Env", Value: "prod" }, { Value: "no-key" }, null, "string-entry"],
      }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.tags).toEqual({ Env: "prod" });
  });

  it("returns empty tags when Tags is not an array", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", { Tags: { notAnArray: true } }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.tags).toEqual({});
  });

  it("returns empty tags when Tags is missing", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", { InstanceType: "t3.small" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.tags).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Type coercion edge cases
// ---------------------------------------------------------------------------

describe("mapCfnResource — type coercion edges", () => {
  it("numeric string values are parsed to numbers", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Fn",
      resource("AWS::Lambda::Function", { MemorySize: "512", Timeout: "60" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.memory_size).toBe(512);
    expect(r!.attributes.timeout).toBe(60);
  });

  it("non-numeric string values become undefined", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "Fn",
      resource("AWS::Lambda::Function", { MemorySize: "abc" }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.memory_size).toBeUndefined();
  });

  it("non-string, non-number values for string-typed attrs become undefined", () => {
    const warnings: string[] = [];
    const r = mapCfnResource(
      "VM",
      resource("AWS::EC2::Instance", { InstanceType: 123 }),
      "us-east-1",
      "t.yaml",
      warnings,
    );
    expect(r!.attributes.instance_type).toBeUndefined();
  });
});
