import { describe, it, expect } from "vitest";
import { parseArgs, validateArgs } from "../../../src/cli.js";

/** Build a full argv (node + script + user args) like process.argv. */
function argv(...args: string[]): string[] {
  return ["node", "cli.ts", ...args];
}

describe("parseArgs", () => {
  it("applies defaults when no options are given", () => {
    const parsed = parseArgs(argv("estimate", "./infra"));
    expect(parsed.command).toBe("estimate");
    expect(parsed.path).toBe("./infra");
    expect(parsed.provider).toBe("aws");
    expect(parsed.region).toBeUndefined();
    expect(parsed.format).toBe("markdown");
    expect(parsed.providers).toEqual(["aws", "azure", "gcp"]);
    expect(parsed.currency).toBe("USD");
    expect(parsed.json).toBe(false);
    expect(parsed.help).toBe(false);
  });

  it("parses --provider, --region, --format and --json", () => {
    const parsed = parseArgs(
      argv(
        "compare",
        "./infra",
        "--provider",
        "gcp",
        "--region",
        "us-central1",
        "--format",
        "focus",
        "--json",
      ),
    );
    expect(parsed.provider).toBe("gcp");
    expect(parsed.region).toBe("us-central1");
    expect(parsed.format).toBe("focus");
    expect(parsed.json).toBe(true);
  });

  it("parses --providers as a trimmed comma-separated list", () => {
    const parsed = parseArgs(argv("optimize", ".", "--providers", "aws, gcp"));
    expect(parsed.providers).toEqual(["aws", "gcp"]);
  });

  it("parses --currency and upper-cases it", () => {
    const parsed = parseArgs(argv("estimate", ".", "--currency", "eur"));
    expect(parsed.currency).toBe("EUR");
  });

  it("parses --changes and --help", () => {
    const parsed = parseArgs(argv("what-if", ".", "--changes", "changes.json", "--help"));
    expect(parsed.changes).toBe("changes.json");
    expect(parsed.help).toBe(true);
  });

  it("takes the first two positionals as command and path, ignoring extras", () => {
    const parsed = parseArgs(argv("analyze", "a", "b"));
    expect(parsed.command).toBe("analyze");
    expect(parsed.path).toBe("a");
  });

  it("ignores a value-taking flag at the end with no value", () => {
    const parsed = parseArgs(argv("estimate", ".", "--provider"));
    expect(parsed.provider).toBe("aws");
  });
});

describe("validateArgs", () => {
  const base = () => parseArgs(argv("estimate", "."));

  it("accepts valid defaults", () => {
    expect(validateArgs(base())).toBeNull();
  });

  it("rejects an unknown provider with a clear message", () => {
    const args = { ...base(), provider: "ibm" };
    expect(validateArgs(args)).toMatch(/Invalid --provider "ibm"/);
    expect(validateArgs(args)).toMatch(/aws, azure, gcp/);
  });

  it("rejects an unknown format with a clear message", () => {
    const args = { ...base(), format: "yaml" };
    expect(validateArgs(args)).toMatch(/Invalid --format "yaml"/);
    expect(validateArgs(args)).toMatch(/markdown, json, csv, focus/);
  });

  it("accepts the focus format", () => {
    expect(validateArgs({ ...base(), format: "focus" })).toBeNull();
  });

  it("rejects an unsupported currency with a clear message", () => {
    const args = { ...base(), currency: "XRP" };
    expect(validateArgs(args)).toMatch(/Invalid --currency "XRP"/);
    expect(validateArgs(args)).toMatch(/USD/);
  });

  it("accepts every supported currency", () => {
    for (const c of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "BRL"]) {
      expect(validateArgs({ ...base(), currency: c })).toBeNull();
    }
  });

  it("rejects invalid tokens inside --providers", () => {
    const args = { ...base(), providers: ["aws", "oracle"] };
    expect(validateArgs(args)).toMatch(/Invalid provider "oracle" in --providers/);
  });
});
