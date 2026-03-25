import { describe, it, expect } from "vitest";
import {
  interpolateByVcpuRatio,
  interpolateByStepOrder,
} from "../../../src/pricing/interpolation.js";

describe("interpolateByVcpuRatio", () => {
  const table: Record<string, number> = {
    standard_d2s_v5: 0.096,
    standard_d4s_v5: 0.192,
    standard_d8s_v5: 0.384,
    standard_e2s_v5: 0.126,
    standard_e4s_v5: 0.252,
  };

  it("returns exact price when resource name matches a table entry", () => {
    const result = interpolateByVcpuRatio("Standard_D4s_v5", table);
    expect(result).toBeCloseTo(0.192, 4);
  });

  it("interpolates price for an unknown size by vCPU ratio", () => {
    // D16s_v5: closest is D8 (distance 8), so price = 0.384 * (16/8) = 0.768
    const result = interpolateByVcpuRatio("Standard_D16s_v5", table);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.384 * (16 / 8), 2);
  });

  it("scales correctly from nearest known entry", () => {
    // D6s: closest is D8 (distance 2), so price = 0.384 * (6/8) = 0.288
    const result = interpolateByVcpuRatio("Standard_D6s_v5", table);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.384 * (6 / 8), 4);
  });

  it("returns undefined when name has no embedded number", () => {
    const result = interpolateByVcpuRatio("Standard_NV", table);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no matching prefix+suffix exists in the table", () => {
    const result = interpolateByVcpuRatio("Standard_F4s_v5", table);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the embedded number is zero", () => {
    const result = interpolateByVcpuRatio("Standard_D0s_v5", table);
    expect(result).toBeUndefined();
  });

  it("matches across different families independently", () => {
    // E8s should interpolate from E-family entries, not D-family
    const result = interpolateByVcpuRatio("Standard_E8s_v5", table);
    expect(result).toBeDefined();
    // Nearest E-family entry is e4s_v5 (0.252), so: 0.252 * (8/4) = 0.504
    expect(result!).toBeCloseTo(0.252 * 2, 4);
  });

  it("accepts a custom key normaliser", () => {
    const customTable: Record<string, number> = {
      "D2S_V5": 0.1,
      "D4S_V5": 0.2,
    };

    const result = interpolateByVcpuRatio("D8S_V5", customTable, (name) =>
      name.toUpperCase()
    );
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.2 * (8 / 4), 4);
  });
});

describe("interpolateByStepOrder", () => {
  const sizeOrder = [
    "nano",
    "micro",
    "small",
    "medium",
    "large",
    "xlarge",
    "2xlarge",
    "4xlarge",
    "8xlarge",
    "16xlarge",
    "24xlarge",
    "48xlarge",
  ] as const;

  const table: Record<string, number> = {
    "m5.large": 0.096,
    "m5.xlarge": 0.192,
    "m5.2xlarge": 0.384,
    "c5.large": 0.085,
  };

  it("returns exact price when instance type matches a table entry", () => {
    const result = interpolateByStepOrder("m5.large", table, sizeOrder);
    expect(result).toBeCloseTo(0.096, 4);
  });

  it("doubles price for each step up", () => {
    // m5.4xlarge is one step above m5.2xlarge -> 0.384 * 2 = 0.768
    const result = interpolateByStepOrder("m5.4xlarge", table, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.768, 4);
  });

  it("halves price for each step down", () => {
    // m5.medium is one step below m5.large -> 0.096 / 2 = 0.048
    const result = interpolateByStepOrder("m5.medium", table, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.048, 4);
  });

  it("scales multiple steps correctly", () => {
    // m5.8xlarge is 2 steps above m5.2xlarge -> 0.384 * 4 = 1.536
    const result = interpolateByStepOrder("m5.8xlarge", table, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(1.536, 4);
  });

  it("interpolates within a different family (c5)", () => {
    // c5.xlarge is one step above c5.large -> 0.085 * 2 = 0.17
    const result = interpolateByStepOrder("c5.xlarge", table, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.17, 4);
  });

  it("returns undefined when type has no dot separator", () => {
    const result = interpolateByStepOrder("m5large", table, sizeOrder);
    expect(result).toBeUndefined();
  });

  it("returns undefined when size is not in the size order", () => {
    const result = interpolateByStepOrder("m5.gigantic", table, sizeOrder);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no entries exist for the family", () => {
    const result = interpolateByStepOrder("r5.large", table, sizeOrder);
    expect(result).toBeUndefined();
  });

  it("handles db-prefixed instance types (RDS)", () => {
    const rdsTable: Record<string, number> = {
      "db.r6g.large": 0.26,
      "db.r6g.xlarge": 0.52,
    };

    const result = interpolateByStepOrder("db.r6g.2xlarge", rdsTable, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(1.04, 4);
  });

  it("is case-insensitive", () => {
    const result = interpolateByStepOrder("M5.Large", table, sizeOrder);
    expect(result).toBeDefined();
    expect(result!).toBeCloseTo(0.096, 4);
  });
});
