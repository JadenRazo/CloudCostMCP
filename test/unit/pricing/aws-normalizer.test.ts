import { describe, it, expect } from "vitest";
import {
  normalizeAwsCompute,
  normalizeAwsDatabase,
  normalizeAwsStorage,
} from "../../../src/pricing/aws/aws-normalizer.js";

describe("normalizeAwsCompute", () => {
  it("extracts price from standard AWS bulk pricing structure", () => {
    const rawProduct = {
      attributes: {
        instanceType: "m5.large",
        operatingSystem: "Linux",
        vcpu: "2",
        memory: "8 GiB",
        tenancy: "Shared",
      },
    };

    const rawPrice = {
      terms: {
        OnDemand: {
          "SKU1.TERM1": {
            priceDimensions: {
              "SKU1.TERM1.RATE1": {
                pricePerUnit: { USD: "0.096" },
                unit: "Hrs",
              },
            },
          },
        },
      },
    };

    const result = normalizeAwsCompute(rawProduct, rawPrice, "us-east-1");

    expect(result.provider).toBe("aws");
    expect(result.service).toBe("ec2");
    expect(result.resource_type).toBe("m5.large");
    expect(result.region).toBe("us-east-1");
    expect(result.price_per_unit).toBe(0.096);
    expect(result.unit).toBe("Hrs");
    expect(result.currency).toBe("USD");
    expect(result.attributes?.instance_type).toBe("m5.large");
    expect(result.attributes?.operating_system).toBe("Linux");
    expect(result.attributes?.pricing_source).toBe("live");
  });

  it("handles missing attributes gracefully", () => {
    const result = normalizeAwsCompute({}, {}, "us-west-2");

    expect(result.resource_type).toBe("unknown");
    expect(result.price_per_unit).toBe(0);
    expect(result.unit).toBe("Hrs");
  });

  it("handles nested OnDemand terms with multiple levels", () => {
    const rawProduct = { attributes: { instanceType: "t3.micro" } };
    const rawPrice = {
      terms: {
        OnDemand: {
          SKU1: {
            "SKU1.OFFERTERM": {
              priceDimensions: {
                "SKU1.OFFERTERM.RATE": {
                  pricePerUnit: { USD: "0.0104" },
                  unit: "Hrs",
                },
              },
            },
          },
        },
      },
    };

    const result = normalizeAwsCompute(rawProduct, rawPrice, "us-east-1");
    expect(result.price_per_unit).toBe(0.0104);
  });
});

describe("normalizeAwsDatabase", () => {
  it("extracts RDS pricing correctly", () => {
    const rawProduct = {
      attributes: {
        instanceType: "db.t3.medium",
        databaseEngine: "MySQL",
        deploymentOption: "Single-AZ",
        vcpu: "2",
        memory: "4 GiB",
      },
    };

    const rawPrice = {
      terms: {
        OnDemand: {
          SKU1: {
            priceDimensions: {
              RATE1: {
                pricePerUnit: { USD: "0.068" },
                unit: "Hrs",
              },
            },
          },
        },
      },
    };

    const result = normalizeAwsDatabase(rawProduct, rawPrice, "us-east-1");

    expect(result.provider).toBe("aws");
    expect(result.service).toBe("rds");
    expect(result.resource_type).toBe("db.t3.medium");
    expect(result.price_per_unit).toBe(0.068);
    expect(result.attributes?.database_engine).toBe("MySQL");
    expect(result.attributes?.pricing_source).toBe("live");
  });

  it("handles empty product and price", () => {
    const result = normalizeAwsDatabase({}, {}, "eu-west-1");

    expect(result.resource_type).toBe("unknown");
    expect(result.price_per_unit).toBe(0);
  });
});

describe("normalizeAwsStorage", () => {
  it("extracts EBS pricing correctly", () => {
    const rawProduct = {
      attributes: {
        volumeApiName: "gp3",
        volumeType: "General Purpose",
        maxIopsvolume: "16000",
        maxThroughputvolume: "1000",
      },
    };

    const rawPrice = {
      terms: {
        OnDemand: {
          SKU1: {
            priceDimensions: {
              RATE1: {
                pricePerUnit: { USD: "0.08" },
                unit: "GB-Mo",
              },
            },
          },
        },
      },
    };

    const result = normalizeAwsStorage(rawProduct, rawPrice, "us-east-1");

    expect(result.provider).toBe("aws");
    expect(result.service).toBe("ebs");
    expect(result.resource_type).toBe("gp3");
    expect(result.price_per_unit).toBe(0.08);
    expect(result.unit).toBe("GB-Mo");
    expect(result.attributes?.volume_type).toBe("gp3");
  });

  it("falls back to volumeType when volumeApiName is missing", () => {
    const rawProduct = {
      attributes: { volumeType: "io2" },
    };

    const result = normalizeAwsStorage(rawProduct, {}, "us-east-1");

    expect(result.resource_type).toBe("io2");
  });

  it("defaults to gp3 when no volume type is available", () => {
    const result = normalizeAwsStorage({}, {}, "us-east-1");
    expect(result.resource_type).toBe("gp3");
  });
});
