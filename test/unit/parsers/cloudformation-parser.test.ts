import { describe, it, expect } from "vitest";
import { CloudFormationParser } from "../../../src/parsers/cloudformation/cfn-parser.js";
import { detectFormat } from "../../../src/parsers/format-detector.js";

const parser = new CloudFormationParser();

// ---------------------------------------------------------------------------
// Fixture templates
// ---------------------------------------------------------------------------

const SIMPLE_EC2_JSON = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Simple EC2 instance",
  Parameters: {
    InstanceType: {
      Type: "String",
      Default: "t3.micro",
    },
  },
  Resources: {
    MyInstance: {
      Type: "AWS::EC2::Instance",
      Properties: {
        InstanceType: "t3.micro",
        ImageId: "ami-0abcdef1234567890",
        Tags: [{ Key: "Name", Value: "my-instance" }],
      },
    },
  },
});

const MULTI_RESOURCE_JSON = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    WebServer: {
      Type: "AWS::EC2::Instance",
      Properties: {
        InstanceType: "m5.large",
        ImageId: "ami-abc123",
      },
    },
    Database: {
      Type: "AWS::RDS::DBInstance",
      Properties: {
        DBInstanceClass: "db.r5.large",
        Engine: "postgres",
        AllocatedStorage: 100,
        MultiAZ: true,
      },
    },
    Bucket: {
      Type: "AWS::S3::Bucket",
      Properties: {
        BucketName: "my-bucket",
      },
    },
  },
});

const YAML_TEMPLATE = `
AWSTemplateFormatVersion: "2010-09-09"
Description: YAML template
Parameters:
  Region:
    Type: String
    Default: eu-west-1
  Env:
    Type: String
    Default: production
Resources:
  AppFunction:
    Type: AWS::Lambda::Function
    Properties:
      MemorySize: 512
      Timeout: 30
  AppQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: app-queue
`;

const PARAM_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Parameters: {
    InstanceType: {
      Type: "String",
      Default: "t3.small",
    },
    Environment: {
      Type: "String",
      // No default — should produce a warning
    },
  },
  Resources: {
    Server: {
      Type: "AWS::EC2::Instance",
      Properties: {
        InstanceType: "t3.small",
        ImageId: "ami-123",
      },
    },
  },
});

const UNSUPPORTED_RESOURCE_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: {
      Type: "AWS::S3::Bucket",
      Properties: {},
    },
    MyCustom: {
      Type: "AWS::CloudWatch::Alarm",
      Properties: {},
    },
  },
});

const EMPTY_RESOURCES_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {},
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloudFormationParser", () => {
  describe("detect", () => {
    it("detects a JSON template with AWSTemplateFormatVersion", () => {
      const files = [{ path: "stack.json", content: SIMPLE_EC2_JSON }];
      expect(parser.detect(files)).toBe(true);
    });

    it("detects a YAML template with AWS:: types", () => {
      const files = [{ path: "stack.yaml", content: YAML_TEMPLATE }];
      expect(parser.detect(files)).toBe(true);
    });

    it("detects .template extension", () => {
      const content = '{"AWSTemplateFormatVersion":"2010-09-09","Resources":{}}';
      const files = [{ path: "infra.template", content }];
      expect(parser.detect(files)).toBe(true);
    });

    it("does not detect a non-CFn JSON file", () => {
      const files = [{ path: "data.json", content: '{"foo": "bar"}' }];
      expect(parser.detect(files)).toBe(false);
    });

    it("does not detect a Terraform file", () => {
      const files = [{ path: "main.tf", content: 'resource "aws_instance" {}' }];
      expect(parser.detect(files)).toBe(false);
    });
  });

  describe("parse – simple EC2 (JSON)", () => {
    it("parses an EC2 instance and returns correct inventory", async () => {
      const files = [{ path: "stack.json", content: SIMPLE_EC2_JSON }];
      const result = await parser.parse(files);

      expect(result.provider).toBe("aws");
      expect(result.region).toBe("us-east-1");
      expect(result.total_count).toBe(1);
      expect(result.resources).toHaveLength(1);

      const ec2 = result.resources[0];
      expect(ec2.type).toBe("aws_instance");
      expect(ec2.id).toBe("MyInstance");
      expect(ec2.attributes.instance_type).toBe("t3.micro");
      expect(ec2.attributes.ami).toBe("ami-0abcdef1234567890");
      expect(ec2.tags).toEqual({ Name: "my-instance" });
    });
  });

  describe("parse – multi-resource template", () => {
    it("parses EC2 + RDS + S3", async () => {
      const files = [{ path: "stack.json", content: MULTI_RESOURCE_JSON }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(3);
      expect(result.by_type).toEqual({
        aws_instance: 1,
        aws_db_instance: 1,
        aws_s3_bucket: 1,
      });

      const rds = result.resources.find((r) => r.type === "aws_db_instance");
      expect(rds).toBeDefined();
      expect(rds!.attributes.instance_type).toBe("db.r5.large");
      expect(rds!.attributes.engine).toBe("postgres");
      expect(rds!.attributes.storage_size_gb).toBe(100);
      expect(rds!.attributes.multi_az).toBe(true);
    });
  });

  describe("parse – YAML format", () => {
    it("parses a YAML template with region parameter", async () => {
      const files = [{ path: "stack.yaml", content: YAML_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.region).toBe("eu-west-1");
      expect(result.total_count).toBe(2);
      expect(result.by_type).toEqual({
        aws_lambda_function: 1,
        aws_sqs_queue: 1,
      });

      const lambda = result.resources.find((r) => r.type === "aws_lambda_function");
      expect(lambda).toBeDefined();
      expect(lambda!.attributes.memory_size).toBe(512);
      expect(lambda!.attributes.timeout).toBe(30);
    });
  });

  describe("parse – parameter defaults and overrides", () => {
    it("warns about parameters with no default and no override", async () => {
      const files = [{ path: "stack.json", content: PARAM_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.parse_warnings).toContain(
        "Parameter 'Environment' has no default value and no override provided",
      );
    });

    it("applies parameter overrides from JSON string", async () => {
      const files = [{ path: "stack.json", content: PARAM_TEMPLATE }];
      const overrides = JSON.stringify({ Environment: "staging", InstanceType: "m5.xlarge" });
      const result = await parser.parse(files, { variableOverrides: overrides });

      // Override applied — no warning for Environment
      expect(result.parse_warnings.some((w) => w.includes("Environment"))).toBe(false);
    });
  });

  describe("parse – unsupported resource types", () => {
    it("generates warnings for unsupported types and still parses supported ones", async () => {
      const files = [{ path: "stack.json", content: UNSUPPORTED_RESOURCE_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(1);
      expect(result.resources[0].type).toBe("aws_s3_bucket");
      expect(result.parse_warnings).toContainEqual(
        expect.stringContaining("AWS::CloudWatch::Alarm"),
      );
    });
  });

  describe("parse – empty resources section", () => {
    it("returns an empty inventory with no warnings", async () => {
      const files = [{ path: "stack.json", content: EMPTY_RESOURCES_TEMPLATE }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.resources).toEqual([]);
    });
  });

  describe("parse – invalid template", () => {
    it("returns warnings for unparseable content", async () => {
      const files = [{ path: "stack.json", content: "not valid json or yaml {{{" }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.parse_warnings.length).toBeGreaterThan(0);
    });

    it("returns warnings for template missing Resources", async () => {
      const files = [{ path: "stack.json", content: '{"Description": "no resources"}' }];
      const result = await parser.parse(files);

      expect(result.total_count).toBe(0);
      expect(result.parse_warnings).toContainEqual(expect.stringContaining("missing Resources"));
    });
  });

  describe("format detector integration", () => {
    it("auto-detects CloudFormation via detectFormat", () => {
      const files = [{ path: "stack.yaml", content: YAML_TEMPLATE }];
      const detected = detectFormat(files);
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe("CloudFormation");
    });

    it("prefers Terraform for .tf files", () => {
      const files = [{ path: "main.tf", content: 'resource "aws_instance" "x" {}' }];
      const detected = detectFormat(files);
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe("Terraform");
    });
  });
});
