/**
 * Tests for parseAzureVmSeries — the SKU-name parser used to feed Azure SQL
 * Database series lookups. Real Azure SKUs come in many shapes (multi-letter
 * families, sub-family prefixes, accelerator segments) and earlier versions
 * of the regex silently rejected several of them, falling back to fallback
 * pricing when live data was available. These cases lock in coverage.
 */

import { describe, it, expect } from "vitest";

import { parseAzureVmSeries } from "../../../src/pricing/azure/retail-client.js";

describe("parseAzureVmSeries", () => {
  it("parses a basic Dsv5 SKU", () => {
    expect(parseAzureVmSeries("Standard_D2s_v5")).toEqual({
      series: "Dsv5",
      vcpus: 2,
    });
  });

  it("parses a multi-digit M-series SKU", () => {
    expect(parseAzureVmSeries("Standard_M64ms_v2")).toEqual({
      series: "Mmsv2",
      vcpus: 64,
    });
  });

  it("parses a 2-letter family (DC = confidential compute)", () => {
    expect(parseAzureVmSeries("Standard_DC4s_v3")).toEqual({
      series: "DCsv3",
      vcpus: 4,
    });
  });

  it("parses a long variant suffix (E96ias_v5)", () => {
    expect(parseAzureVmSeries("Standard_E96ias_v5")).toEqual({
      series: "Eiasv5",
      vcpus: 96,
    });
  });

  it("parses an accelerator-tagged SKU (NC4as_T4_v3)", () => {
    expect(parseAzureVmSeries("Standard_NC4as_T4_v3")).toEqual({
      series: "NCasT4v3",
      vcpus: 4,
    });
  });

  it("parses a sub-family prefix SKU (Eb8as_v5)", () => {
    expect(parseAzureVmSeries("Standard_Eb8as_v5")).toEqual({
      series: "Ebasv5",
      vcpus: 8,
    });
  });

  it("returns null for unrecognised shapes", () => {
    expect(parseAzureVmSeries("nonsense")).toBeNull();
    expect(parseAzureVmSeries("Standard_D")).toBeNull();
    expect(parseAzureVmSeries("Basic_A1")).toBeNull();
  });
});
