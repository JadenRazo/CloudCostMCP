import { describe, it, expect } from "vitest";
import { csvEscape } from "../../../src/reporting/csv-escape.js";

describe("csvEscape formula-injection neutralization", () => {
  it("prefixes leading = with a single quote", () => {
    expect(csvEscape('=HYPERLINK("http://evil","click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""click"")"`,
    );
  });

  it("prefixes leading + with a single quote", () => {
    // No comma/quote/newline means no surrounding quotes — just the ' prefix.
    expect(csvEscape("+cmd|' /c calc'!A0")).toBe(`'+cmd|' /c calc'!A0`);
  });

  it("prefixes leading - with a single quote", () => {
    expect(csvEscape("-1+1")).toBe("'-1+1");
  });

  it("prefixes leading @ with a single quote", () => {
    expect(csvEscape("@SUM(A1:A5)")).toBe("'@SUM(A1:A5)");
  });

  it("prefixes leading tab character with a single quote", () => {
    // Tab alone does not trigger the quote wrapper (only ",\n\r, do).
    expect(csvEscape("\tleading tab")).toBe("'\tleading tab");
  });

  it("prefixes leading CR with a single quote", () => {
    // CR also triggers the newline-quoting rule, so output is quoted.
    const out = csvEscape("\rstart");
    expect(out.startsWith(`"'\r`)).toBe(true);
  });

  it("does not prefix normal strings", () => {
    expect(csvEscape("us-east-1")).toBe("us-east-1");
    expect(csvEscape("Production App")).toBe("Production App");
  });

  it("does not prefix strings where = appears mid-content", () => {
    expect(csvEscape("key=value")).toBe("key=value");
  });
});

describe("csvEscape row-injection / quoting", () => {
  it("quotes on CR to prevent bare-\\r row injection", () => {
    expect(csvEscape("foo\rbar")).toBe('"foo\rbar"');
  });

  it("quotes on LF", () => {
    expect(csvEscape("foo\nbar")).toBe('"foo\nbar"');
  });

  it("quotes on comma", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("quotes on embedded quote and doubles it", () => {
    expect(csvEscape('say "hi"')).toBe(`"say ""hi"""`);
  });

  it("emits empty cells for non-finite numbers", () => {
    expect(csvEscape(Number.NaN)).toBe("");
    expect(csvEscape(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("renders numbers without formula prefix even when negative", () => {
    expect(csvEscape(-0.5)).toBe("-0.5");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(15.75)).toBe("15.75");
  });
});
