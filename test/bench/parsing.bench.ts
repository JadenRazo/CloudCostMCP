import { bench, describe } from "vitest";
import { parseTerraform } from "../../src/parsers/index.js";
import { CloudFormationParser } from "../../src/parsers/cloudformation/cfn-parser.js";
import { PulumiParser } from "../../src/parsers/pulumi/pulumi-parser.js";
import { ArmParser } from "../../src/parsers/bicep/arm-parser.js";
import { detectFormat } from "../../src/parsers/format-detector.js";

// ---------------------------------------------------------------------------
// Terraform fixtures
// ---------------------------------------------------------------------------

function tfResource(type: string, name: string, attrs: string): string {
  return `resource "${type}" "${name}" {\n${attrs}\n}\n`;
}

const TF_SMALL = [
  tfResource(
    "aws_instance",
    "web",
    '  ami           = "ami-12345"\n  instance_type = "t3.large"\n  tags = { Name = "web" }',
  ),
  tfResource(
    "aws_instance",
    "api",
    '  ami           = "ami-12345"\n  instance_type = "t3.medium"\n  tags = { Name = "api" }',
  ),
  tfResource(
    "aws_db_instance",
    "main",
    '  engine         = "postgres"\n  instance_class = "db.t3.medium"\n  allocated_storage = 50',
  ),
  tfResource("aws_s3_bucket", "assets", '  bucket = "my-assets"\n  tags   = { Env = "prod" }'),
  tfResource("aws_ebs_volume", "data", '  availability_zone = "us-east-1a"\n  size = 100'),
].join("\n");

const TF_LARGE = Array.from({ length: 20 }, (_, i) => {
  const types = [
    {
      type: "aws_instance",
      attrs: `  ami           = "ami-${String(i).padStart(5, "0")}"\n  instance_type = "t3.large"\n  tags = { Name = "svc-${i}" }`,
    },
    {
      type: "aws_db_instance",
      attrs: `  engine         = "mysql"\n  instance_class = "db.r5.large"\n  allocated_storage = ${20 + i * 10}`,
    },
    {
      type: "aws_s3_bucket",
      attrs: `  bucket = "bucket-${i}"\n  tags = { Team = "platform" }`,
    },
    {
      type: "aws_ebs_volume",
      attrs: `  availability_zone = "us-east-1a"\n  size = ${50 + i * 5}`,
    },
  ];
  const pick = types[i % types.length];
  return tfResource(pick.type, `res_${i}`, pick.attrs);
}).join("\n");

// ---------------------------------------------------------------------------
// CloudFormation fixture (5 resources)
// ---------------------------------------------------------------------------

const CFN_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    WebServer: {
      Type: "AWS::EC2::Instance",
      Properties: { InstanceType: "t3.large", ImageId: "ami-12345" },
    },
    ApiServer: {
      Type: "AWS::EC2::Instance",
      Properties: { InstanceType: "t3.medium", ImageId: "ami-12345" },
    },
    Database: {
      Type: "AWS::RDS::DBInstance",
      Properties: {
        DBInstanceClass: "db.t3.medium",
        Engine: "postgres",
        AllocatedStorage: 50,
      },
    },
    AssetsBucket: {
      Type: "AWS::S3::Bucket",
      Properties: { BucketName: "my-assets" },
    },
    DataVolume: {
      Type: "AWS::EC2::Volume",
      Properties: { AvailabilityZone: "us-east-1a", Size: 100 },
    },
  },
});

// ---------------------------------------------------------------------------
// Pulumi fixture (5 resources)
// ---------------------------------------------------------------------------

const PULUMI_EXPORT = JSON.stringify({
  version: 3,
  deployment: {
    manifest: { time: "2024-01-01T00:00:00Z", magic: "", version: "" },
    resources: [
      { type: "pulumi:pulumi:Stack", urn: "urn:pulumi:dev::proj::pulumi:pulumi:Stack::proj-dev" },
      {
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:dev::proj::aws:ec2/instance:Instance::web",
        inputs: { instanceType: "t3.large", ami: "ami-12345" },
      },
      {
        type: "aws:ec2/instance:Instance",
        urn: "urn:pulumi:dev::proj::aws:ec2/instance:Instance::api",
        inputs: { instanceType: "t3.medium", ami: "ami-12345" },
      },
      {
        type: "aws:rds/instance:Instance",
        urn: "urn:pulumi:dev::proj::aws:rds/instance:Instance::db",
        inputs: { instanceClass: "db.t3.medium", engine: "postgres", allocatedStorage: 50 },
      },
      {
        type: "aws:s3/bucket:Bucket",
        urn: "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::assets",
        inputs: { bucket: "my-assets" },
      },
      {
        type: "aws:ebs/volume:Volume",
        urn: "urn:pulumi:dev::proj::aws:ebs/volume:Volume::data",
        inputs: { availabilityZone: "us-east-1a", size: 100 },
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// ARM fixture (5 resources)
// ---------------------------------------------------------------------------

const ARM_TEMPLATE = JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: "2023-07-01",
      name: "web-vm",
      location: "eastus",
      properties: { hardwareProfile: { vmSize: "Standard_D2s_v3" } },
    },
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: "2023-07-01",
      name: "api-vm",
      location: "eastus",
      properties: { hardwareProfile: { vmSize: "Standard_D4s_v3" } },
    },
    {
      type: "Microsoft.DBforPostgreSQL/flexibleServers",
      apiVersion: "2022-12-01",
      name: "main-db",
      location: "eastus",
      sku: { name: "Standard_D2s_v3", tier: "GeneralPurpose" },
      properties: { storage: { storageSizeGB: 64 } },
    },
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-01-01",
      name: "assetsaccount",
      location: "eastus",
      kind: "StorageV2",
      sku: { name: "Standard_LRS" },
    },
    {
      type: "Microsoft.Compute/disks",
      apiVersion: "2023-04-02",
      name: "data-disk",
      location: "eastus",
      properties: { diskSizeGB: 128 },
      sku: { name: "Premium_LRS" },
    },
  ],
});

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Terraform parsing", () => {
  bench("parseTerraform - 5 resources", async () => {
    await parseTerraform([{ path: "main.tf", content: TF_SMALL }], undefined, "/tmp", false);
  });

  bench("parseTerraform - 20 resources", async () => {
    await parseTerraform([{ path: "main.tf", content: TF_LARGE }], undefined, "/tmp", false);
  });
});

describe("CloudFormation parsing", () => {
  const parser = new CloudFormationParser();

  bench("CloudFormationParser.parse - 5 resources", async () => {
    await parser.parse([{ path: "template.json", content: CFN_TEMPLATE }]);
  });
});

describe("Pulumi parsing", () => {
  const parser = new PulumiParser();

  bench("PulumiParser.parse - 5 resources", async () => {
    await parser.parse([{ path: "stack.json", content: PULUMI_EXPORT }]);
  });
});

describe("ARM parsing", () => {
  const parser = new ArmParser();

  bench("ArmParser.parse - 5 resources", async () => {
    await parser.parse([{ path: "template.json", content: ARM_TEMPLATE }]);
  });
});

describe("Format detection", () => {
  bench("detectFormat - Terraform (.tf)", () => {
    detectFormat([{ path: "main.tf", content: TF_SMALL }]);
  });

  bench("detectFormat - CloudFormation (.json)", () => {
    detectFormat([{ path: "template.json", content: CFN_TEMPLATE }]);
  });

  bench("detectFormat - ARM (.json)", () => {
    detectFormat([{ path: "template.json", content: ARM_TEMPLATE }]);
  });

  bench("detectFormat - Pulumi (.json)", () => {
    detectFormat([{ path: "stack.json", content: PULUMI_EXPORT }]);
  });
});
