import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { registerTools } from "./tools/index.js";

export async function startServer(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logging.level);

  const server = new McpServer({
    name: "cloudcost-mcp",
    version: "0.1.0",
  });

  registerTools(server, config);

  const transport = new StdioServerTransport();
  logger.info("Starting CloudCost MCP server");
  await server.connect(transport);
}
