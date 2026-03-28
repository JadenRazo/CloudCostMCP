import { describe, it, expect } from "vitest";
import {
  calculateLambdaCost,
  calculateDynamoDbCost,
  calculateSqsCost,
} from "../../../src/calculator/serverless.js";
import type { ParsedResource } from "../../../src/types/resources.js";

function makeResource(overrides: Partial<ParsedResource>): ParsedResource {
  return {
    id: "test-resource",
    type: "aws_lambda_function",
    name: "test-fn",
    provider: "aws",
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lambda
// ---------------------------------------------------------------------------

describe("calculateLambdaCost", () => {
  it("computes cost with default assumptions", () => {
    const resource = makeResource({ type: "aws_lambda_function" });
    const estimate = calculateLambdaCost(resource, "aws", "us-east-1");

    // Default: 1M invocations, 200ms, 128MB x86_64
    // Request cost: (1 / 1) * 0.20 = $0.20
    // GB-seconds: 1_000_000 * 0.2 * (128/1024) = 25,000
    // Compute cost: 25,000 * 0.0000166667 ≈ $0.4167
    expect(estimate.monthly_cost).toBeGreaterThan(0);
    expect(estimate.breakdown).toHaveLength(2);
    expect(estimate.breakdown[0]!.description).toContain("requests");
    expect(estimate.breakdown[1]!.description).toContain("compute");
    expect(estimate.currency).toBe("USD");
    expect(estimate.confidence).toBe("medium");
  });

  it("uses memory_size attribute when provided", () => {
    const resource = makeResource({
      type: "aws_lambda_function",
      attributes: { memory_size: 512 },
    });
    const smallResource = makeResource({
      type: "aws_lambda_function",
      attributes: { memory_size: 128 },
    });

    const largeEstimate = calculateLambdaCost(resource, "aws", "us-east-1");
    const smallEstimate = calculateLambdaCost(smallResource, "aws", "us-east-1");

    // More memory → higher GB-seconds → higher compute cost
    expect(largeEstimate.monthly_cost).toBeGreaterThan(smallEstimate.monthly_cost);
  });

  it("applies arm64 discount vs x86_64", () => {
    const x86 = makeResource({
      attributes: { architecture: "x86_64", memory_size: 128 },
    });
    const arm = makeResource({
      attributes: { architecture: "arm64", memory_size: 128 },
    });

    const x86Estimate = calculateLambdaCost(x86, "aws", "us-east-1");
    const armEstimate = calculateLambdaCost(arm, "aws", "us-east-1");

    // arm64 compute is ~20% cheaper
    expect(armEstimate.monthly_cost).toBeLessThan(x86Estimate.monthly_cost);
  });

  it("notes default assumption when no invocations specified", () => {
    const resource = makeResource({});
    const estimate = calculateLambdaCost(resource, "aws", "us-east-1");

    expect(estimate.notes.some((n) => n.includes("Default invocation assumption"))).toBe(true);
  });

  it("yearly cost is 12x monthly", () => {
    const resource = makeResource({});
    const estimate = calculateLambdaCost(resource, "aws", "us-east-1");

    expect(estimate.yearly_cost).toBeCloseTo(estimate.monthly_cost * 12, 5);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

describe("calculateDynamoDbCost", () => {
  it("calculates on-demand mode with default assumptions", () => {
    const resource = makeResource({
      type: "aws_dynamodb_table",
      attributes: { billing_mode: "PAY_PER_REQUEST" },
    });
    const estimate = calculateDynamoDbCost(resource, "aws", "us-east-1");

    // Default: 1M writes @ $1.25/M + 1M reads @ $0.25/M + 1GB storage @ $0.25
    expect(estimate.monthly_cost).toBeCloseTo(1.25 + 0.25 + 0.25, 2);
    expect(estimate.breakdown).toHaveLength(3);
    expect(estimate.confidence).toBe("medium");
  });

  it("calculates provisioned mode", () => {
    const resource = makeResource({
      type: "aws_dynamodb_table",
      attributes: {
        billing_mode: "PROVISIONED",
        read_capacity: 10,
        write_capacity: 5,
      },
    });
    const estimate = calculateDynamoDbCost(resource, "aws", "us-east-1");

    // WCU: 5 * $0.00065/hr * 730 = $2.3725
    // RCU: 10 * $0.00013/hr * 730 = $0.949
    // Storage: 1 * $0.25 = $0.25
    const expectedInstance = 5 * 0.00065 * 730 + 10 * 0.00013 * 730;
    expect(estimate.monthly_cost).toBeCloseTo(expectedInstance + 0.25, 1);
  });

  it("notes provisioned mode in output", () => {
    const resource = makeResource({
      type: "aws_dynamodb_table",
      attributes: { billing_mode: "PROVISIONED", read_capacity: 5, write_capacity: 5 },
    });
    const estimate = calculateDynamoDbCost(resource, "aws", "us-east-1");

    expect(estimate.notes.some((n) => n.includes("Provisioned"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQS
// ---------------------------------------------------------------------------

describe("calculateSqsCost", () => {
  it("calculates standard queue cost with defaults", () => {
    const resource = makeResource({
      type: "aws_sqs_queue",
      attributes: {},
    });
    const estimate = calculateSqsCost(resource, "aws", "us-east-1");

    // Standard: 1M messages * $0.40/M = $0.40
    expect(estimate.monthly_cost).toBeCloseTo(0.4, 2);
    expect(estimate.breakdown[0]!.description).toContain("Standard");
  });

  it("applies FIFO premium pricing", () => {
    const standard = makeResource({
      type: "aws_sqs_queue",
      attributes: { fifo_queue: false },
    });
    const fifo = makeResource({
      type: "aws_sqs_queue",
      attributes: { fifo_queue: true },
    });

    const standardEst = calculateSqsCost(standard, "aws", "us-east-1");
    const fifoEst = calculateSqsCost(fifo, "aws", "us-east-1");

    // FIFO is $0.50/M vs $0.40/M
    expect(fifoEst.monthly_cost).toBeGreaterThan(standardEst.monthly_cost);
    expect(fifoEst.breakdown[0]!.description).toContain("FIFO");
  });

  it("includes default assumption note when no messages specified", () => {
    const resource = makeResource({ type: "aws_sqs_queue" });
    const estimate = calculateSqsCost(resource, "aws", "us-east-1");

    expect(estimate.notes.some((n) => n.includes("Default assumption"))).toBe(true);
  });
});
