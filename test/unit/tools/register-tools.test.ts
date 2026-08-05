import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../../src/tools/index.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";

// check_cost_budget's structured error returns (error: "provider_unresolved" |
// "non_finite_total") are defense-in-depth branches that are not reachable
// through the real parser today (it defaults unknown providers to aws — see
// the note in check-cost-budget.test.ts). Stub the handler for the isError
// wiring assertion; the schema and registration remain the real ones.
vi.mock("../../../src/tools/check-cost-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/tools/check-cost-budget.js")>();
  return {
    ...actual,
    checkCostBudget: vi.fn(() =>
      Promise.resolve({
        verdict: "block",
        total_monthly: 0,
        currency: "USD",
        resource_count: 0,
        thresholds: {
          max_monthly: undefined,
          max_per_resource: undefined,
          source: { max_monthly: "none", max_per_resource: "none" },
        },
        reasons: ["provider could not be determined"],
        blocking_resources: [],
        warning_resources: [],
        summary: "block: provider could not be determined",
        error: "provider_unresolved",
      }),
    ),
  };
});

/**
 * Guards the SemVer-locked MCP tool surface: every tool in VERSIONING.md's
 * locked table must register (and nothing else), and every tool must carry
 * the readOnlyHint annotation (no CloudCost tool mutates anything).
 */

// The 12 locked tool names from VERSIONING.md ("Stable surface" table).
const LOCKED_TOOLS = [
  "analyze_terraform",
  "estimate_cost",
  "compare_providers",
  "get_equivalents",
  "get_pricing",
  "optimize_cost",
  "what_if",
  "analyze_plan",
  "compare_actual",
  "price_trends",
  "detect_anomalies",
  "check_cost_budget",
] as const;

let tmpDir: string;
let client: Client;
let server: McpServer;
let closeTools: () => void;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cloudcost-tools-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.cache.db_path = join(tmpDir, "cache.db");

  server = new McpServer({ name: "cloudcost-mcp-test", version: "0.0.0" });
  closeTools = registerTools(server, config);

  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  closeTools();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerTools", () => {
  it("registers exactly the 12 SemVer-locked tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...LOCKED_TOOLS].sort());
    expect(tools).toHaveLength(12);
  });

  it("stays in sync with VERSIONING.md's locked tool table", () => {
    const versioningMd = readFileSync(join(__dirname, "../../../VERSIONING.md"), "utf8");
    const documented = [...versioningMd.matchAll(/^\| `([a-z_]+)` +\|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...LOCKED_TOOLS].sort());
  });

  it("marks every tool read-only via annotations.readOnlyHint", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} missing readOnlyHint`).toBe(true);
    }
  });

  it("every tool has a non-empty description and an input schema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeTruthy();
    }
  });

  it("wraps thrown handler errors in an isError JSON envelope", async () => {
    // analyze_plan with malformed JSON content triggers a handler error path.
    const result = await client.callTool({
      name: "analyze_plan",
      arguments: { plan_json: "{not json" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text) as { error?: string };
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error!.length).toBeGreaterThan(0);
  });

  it("flags check_cost_budget structured errors (provider_unresolved) as isError", async () => {
    const result = await client.callTool({
      name: "check_cost_budget",
      arguments: {
        files: [{ path: "main.tf", content: "# empty\n" }],
        max_monthly: 100,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0].text) as { error?: string; verdict?: string };
    expect(parsed.error).toBe("provider_unresolved");
    expect(parsed.verdict).toBe("block");
  });
});
