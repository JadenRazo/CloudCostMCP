import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeForMessage } from "../../../src/util/sanitize.js";
import { safeJsonParse, stripForbiddenKeys } from "../../../src/parsers/safe-json.js";
import { resolveWithinBoundary } from "../../../src/parsers/path-safety.js";
import { resolveModules } from "../../../src/parsers/module-resolver.js";
import { parseTerraformState } from "../../../src/parsers/terraform/state-parser.js";
import { parseTerraformPlan } from "../../../src/parsers/terraform/plan-parser.js";
import { analyzeTerraformSchema } from "../../../src/tools/analyze-terraform.js";
import { estimateCostSchema } from "../../../src/tools/estimate-cost.js";
import { analyzePlanSchema } from "../../../src/tools/analyze-plan.js";
import { compareActualSchema } from "../../../src/tools/compare-actual.js";
import {
  MAX_FILE_CONTENT_BYTES,
  MAX_FILE_PATH_LEN,
  MAX_PLAN_JSON_BYTES,
  MAX_STATE_JSON_BYTES,
} from "../../../src/schemas/bounded.js";

// ---------------------------------------------------------------------------
// Sanitisation of user-supplied strings echoed back to MCP client
// ---------------------------------------------------------------------------

describe("sanitizeForMessage", () => {
  it("strips ASCII control characters", () => {
    const poisoned = "good\x00\x07\x1bvalue";
    expect(sanitizeForMessage(poisoned)).toBe("goodvalue");
  });

  it("strips zero-width and bidi-override characters used for hidden prompt injection", () => {
    const hidden = "safe\u200B\u200E\u202Epayload\uFEFFend";
    expect(sanitizeForMessage(hidden)).toBe("safepayloadend");
  });

  it("caps excessively long strings to protect the model context", () => {
    const long = "a".repeat(5000);
    const result = sanitizeForMessage(long, 256);
    expect(result.length).toBeLessThanOrEqual(257); // 256 + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  it("coerces non-string input safely", () => {
    expect(sanitizeForMessage(42)).toBe("42");
    expect(sanitizeForMessage(null)).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// Prototype-pollution defences
// ---------------------------------------------------------------------------

describe("safeJsonParse", () => {
  afterEach(() => {
    // Guarantee no prior test poisoned the prototype for subsequent tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Object.prototype as any).polluted;
  });

  it("strips __proto__ from a crafted payload", () => {
    const payload = '{"__proto__": {"polluted": "yes"}, "safe": 1}';
    const parsed = safeJsonParse<Record<string, unknown>>(payload);
    expect(parsed.safe).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted as string | undefined).toBeUndefined();
  });

  it("strips nested constructor/prototype keys", () => {
    const payload = JSON.stringify({
      resource_changes: [{ constructor: { prototype: { polluted: true } } }],
    });
    const parsed = safeJsonParse<{ resource_changes: Array<Record<string, unknown>> }>(payload);
    expect(Object.hasOwn(parsed.resource_changes[0], "constructor")).toBe(false);
    expect(Object.hasOwn(parsed.resource_changes[0], "prototype")).toBe(false);
  });
});

describe("stripForbiddenKeys", () => {
  it("recursively removes dangerous keys", () => {
    const input = {
      a: 1,
      nested: { __proto__: { bad: true }, ok: 2 } as unknown,
      arr: [{ constructor: "bad", good: 3 }],
    };
    const result = stripForbiddenKeys(input) as Record<string, unknown>;
    const nested = result.nested as Record<string, unknown>;
    const arrFirst = (result.arr as Array<Record<string, unknown>>)[0];
    expect(nested.ok).toBe(2);
    expect(Object.hasOwn(nested, "__proto__")).toBe(false);
    expect(arrFirst.good).toBe(3);
    expect(Object.hasOwn(arrFirst, "constructor")).toBe(false);
  });
});

describe("parseTerraformState / parseTerraformPlan prototype-pollution guards", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Object.prototype as any).polluted;
  });

  it("does not pollute Object.prototype from a malicious state payload", () => {
    const malicious = JSON.stringify({
      version: 4,
      terraform_version: "1.0.0",
      resources: [],
      __proto__: { polluted: "yes" },
    });
    parseTerraformState(malicious);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted as string | undefined).toBeUndefined();
  });

  it("does not pollute Object.prototype from a malicious plan payload", () => {
    const malicious = JSON.stringify({
      resource_changes: [],
      __proto__: { polluted: "yes" },
    });
    parseTerraformPlan(malicious);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted as string | undefined).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path traversal and symlink defences
// ---------------------------------------------------------------------------

describe("resolveWithinBoundary", () => {
  let tmpRoot: string;

  const setup = () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "cloudcost-path-"));
    mkdirSync(join(tmpRoot, "inside"), { recursive: true });
    mkdirSync(join(tmpRoot, "inside", "child"), { recursive: true });
    mkdirSync(join(tmpRoot, "outside"), { recursive: true });
    writeFileSync(join(tmpRoot, "outside", "secret.tf"), "# secret");
  };

  const teardown = () => {
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  it("accepts paths inside the boundary", () => {
    setup();
    try {
      const boundary = join(tmpRoot, "inside");
      const resolved = resolveWithinBoundary("./child", boundary, boundary);
      expect(resolved).not.toBeNull();
      expect(resolved).toBe(join(boundary, "child"));
    } finally {
      teardown();
    }
  });

  it("rejects traversal outside the boundary", () => {
    setup();
    try {
      const boundary = join(tmpRoot, "inside");
      const resolved = resolveWithinBoundary("../outside", boundary, boundary);
      expect(resolved).toBeNull();
    } finally {
      teardown();
    }
  });

  it("rejects symlinks even when the target is inside the boundary", () => {
    setup();
    try {
      const boundary = join(tmpRoot, "inside");
      const target = join(boundary, "child");
      const link = join(boundary, "link");
      symlinkSync(target, link);
      const resolved = resolveWithinBoundary("./link", boundary, boundary);
      expect(resolved).toBeNull();
    } finally {
      teardown();
    }
  });
});

describe("resolveModules – path-traversal defence", () => {
  it("rejects a local module source that escapes the project root", async () => {
    // process.cwd() is the default boundary; "../" from cwd escapes the
    // project root and must be rejected with a warning.
    const warnings: string[] = [];
    const hclJson = {
      module: {
        malicious: [{ source: "../../../../../../etc" }],
      },
    };

    const resources = await resolveModules(hclJson, process.cwd(), {}, warnings);

    expect(resources).toHaveLength(0);
    expect(
      warnings.some(
        (w) => w.includes("resolves outside the allowed root") && w.includes("malicious"),
      ),
    ).toBe(true);
  });

  it("sanitizes module names and sources before echoing into warnings", async () => {
    const warnings: string[] = [];
    // Hidden zero-width inside the module name — must not make it into the
    // warning text.
    const hclJson = {
      module: {
        "evil\u200Bname": [{ source: "git::https://example.com/repo" }],
      },
    };

    await resolveModules(hclJson, process.cwd(), {}, warnings);

    expect(warnings.some((w) => w.includes("\u200B"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input-size Zod limits on tool schemas
// ---------------------------------------------------------------------------

describe("tool schema size limits", () => {
  it("rejects oversized file content", () => {
    const oversized = "a".repeat(MAX_FILE_CONTENT_BYTES + 1);
    const result = analyzeTerraformSchema.safeParse({
      files: [{ path: "main.tf", content: oversized }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized file path", () => {
    const longPath = "a".repeat(MAX_FILE_PATH_LEN + 1);
    const result = estimateCostSchema.safeParse({
      files: [{ path: longPath, content: "" }],
      provider: "aws",
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized plan_json", () => {
    const oversized = "a".repeat(MAX_PLAN_JSON_BYTES + 1);
    const result = analyzePlanSchema.safeParse({ plan_json: oversized });
    expect(result.success).toBe(false);
  });

  it("rejects oversized state_json", () => {
    const oversized = "a".repeat(MAX_STATE_JSON_BYTES + 1);
    const result = compareActualSchema.safeParse({ state_json: oversized });
    expect(result.success).toBe(false);
  });

  it("rejects an excessively large files array", () => {
    const files = Array.from({ length: 2001 }, (_, i) => ({
      path: `f${i}.tf`,
      content: "",
    }));
    const result = analyzeTerraformSchema.safeParse({ files });
    expect(result.success).toBe(false);
  });
});
