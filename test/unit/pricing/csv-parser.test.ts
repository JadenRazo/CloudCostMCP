import { describe, it, expect } from "vitest";
import { parseCsvLine } from "../../../src/pricing/aws/csv-parser.js";

describe("parseCsvLine", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("parses a simple unquoted CSV line", () => {
    const result = parseCsvLine("a,b,c");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("parses a realistic AWS bulk pricing header", () => {
    const header =
      "SKU,OfferTermCode,RateCode,TermType,PriceDescription,EffectiveDate,StartingRange,EndingRange,Unit,PricePerUnit,Currency";
    const fields = parseCsvLine(header);
    expect(fields).toHaveLength(11);
    expect(fields[0]).toBe("SKU");
    expect(fields[10]).toBe("Currency");
  });

  it("parses a realistic AWS bulk pricing data row", () => {
    const row =
      '"ABC123","JRTCKXETXF","ABC123.JRTCKXETXF.6YS6EN2CT7","OnDemand","$0.096 per On Demand Linux m5.large Instance Hour","2024-01-01T00:00:00Z","0","Inf","Hrs","0.0960000000","USD"';
    const fields = parseCsvLine(row);
    expect(fields).toHaveLength(11);
    expect(fields[0]).toBe("ABC123");
    expect(fields[3]).toBe("OnDemand");
    expect(fields[9]).toBe("0.0960000000");
    expect(fields[10]).toBe("USD");
  });

  // -------------------------------------------------------------------------
  // Quoted fields
  // -------------------------------------------------------------------------

  it("handles quoted fields containing commas", () => {
    const result = parseCsvLine('"hello, world",foo,bar');
    expect(result).toEqual(["hello, world", "foo", "bar"]);
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const result = parseCsvLine('"She said ""hello""",done');
    expect(result).toEqual(['She said "hello"', "done"]);
  });

  it("handles a mix of quoted and unquoted fields", () => {
    const result = parseCsvLine('plain,"quoted",also plain');
    expect(result).toEqual(["plain", "quoted", "also plain"]);
  });

  it("handles an entirely quoted single field", () => {
    const result = parseCsvLine('"only field"');
    expect(result).toEqual(["only field"]);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("returns an empty array for empty input", () => {
    const result = parseCsvLine("");
    expect(result).toEqual([]);
  });

  it("handles a single unquoted field", () => {
    const result = parseCsvLine("value");
    expect(result).toEqual(["value"]);
  });

  it("handles trailing comma producing an extra empty field", () => {
    const result = parseCsvLine("a,b,");
    expect(result).toEqual(["a", "b", ""]);
  });

  it("handles consecutive commas (empty fields in the middle)", () => {
    const result = parseCsvLine("a,,c");
    expect(result).toEqual(["a", "", "c"]);
  });

  it("handles multiple consecutive commas", () => {
    const result = parseCsvLine(",,,");
    expect(result).toEqual(["", "", "", ""]);
  });

  it("handles quoted empty field", () => {
    const result = parseCsvLine('"",b');
    expect(result).toEqual(["", "b"]);
  });

  it("handles quoted field with only escaped quotes", () => {
    const result = parseCsvLine('""""');
    expect(result).toEqual(['"']);
  });

  // -------------------------------------------------------------------------
  // Whitespace
  // -------------------------------------------------------------------------

  it("preserves whitespace inside unquoted fields", () => {
    const result = parseCsvLine(" a , b , c ");
    expect(result).toEqual([" a ", " b ", " c "]);
  });

  it("preserves whitespace inside quoted fields", () => {
    const result = parseCsvLine('" a "," b "');
    expect(result).toEqual([" a ", " b "]);
  });

  // -------------------------------------------------------------------------
  // Realistic multi-field AWS row with descriptions containing commas
  // -------------------------------------------------------------------------

  it("correctly splits a row where the description field contains commas", () => {
    const row = 'SKU1,OnDemand,"$0.10 per GB, first 10 TB",2024-01-01,Hrs,0.10,USD';
    const fields = parseCsvLine(row);
    expect(fields).toHaveLength(7);
    expect(fields[2]).toBe("$0.10 per GB, first 10 TB");
    expect(fields[6]).toBe("USD");
  });
});
