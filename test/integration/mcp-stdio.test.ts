import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("patched SDK stdio transport", () => {
  it("initializes, lists tools, validates requests and returns bundled GCP pricing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudcost-mcp-regression-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      env: { CLOUDCOST_CACHE_PATH: join(dir, "cache.db") },
      stderr: "pipe",
    });
    const client = new Client({ name: "dependency-regression", version: "1.0.0" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "get_pricing")).toBe(true);
      const result = await client.callTool({
        name: "get_pricing",
        arguments: {
          provider: "gcp",
          service: "compute",
          resource_type: "e2-standard-2",
          region: "us-central1",
        },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as { price: { hourlyPrice: number } };
      expect(parsed.price).toBeTruthy();
      expect(JSON.stringify(parsed.price)).toContain("gcp");
      const invalid = await client.callTool({
        name: "get_pricing",
        arguments: { provider: "invalid" },
      });
      expect(invalid.isError).toBe(true);
    } catch (error) {
      throw new Error(`MCP stdio failed: ${stderr}`, { cause: error });
    } finally {
      await client.close();
      await transport.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
