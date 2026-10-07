import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Services } from "../core/services.js";
import { AppError } from "../core/errors.js";
import { listFiles, ListFilesSchema } from "../tools/index.js";

type Context = {
  agentId: string;
  services: Services;
};

export function createServer(ctx: Context): Server {
  const server = new Server(
    {
      name: "mcp-workspace",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "list_files") {
        const input = ListFilesSchema.parse(args ?? {});
        const result = await listFiles(input, ctx.services);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err) {
      const message = err instanceof AppError ? err.message : "Internal error";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  server.setRequestHandler("tools/list" as any, async () => {
    return {
      tools: [
        {
          name: "list_files",
          description:
            "List files and directories in the workspace. Returns name, type, and relative path for each entry.",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative path within workspace (default: '.')",
                default: ".",
              },
              recursive: {
                type: "boolean",
                description: "List subdirectories recursively (default: false)",
                default: false,
              },
            },
          },
        },
      ],
    };
  });

  return server;
}

