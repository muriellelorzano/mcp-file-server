import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tools/context.js";
import { registerAllTools } from "../tools/index.js";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "mcp-workspace",
    version: "0.1.0",
  });
  registerAllTools(server, ctx);
  return server;
}
