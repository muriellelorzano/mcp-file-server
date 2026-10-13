import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Services } from "../core/services.js";
import { requireAuth, type Authenticate } from "./auth.js";
import { createServer } from "./createServer.js";

const MCP_PATHS = ["/mcp", "/mcp/:key"];

export function createApp(services: Services, authenticate: Authenticate) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  // public: reveals nothing except that the process is up
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // every method on /mcp requires a valid token, so 405s don't leak either
  app.all(MCP_PATHS, requireAuth(authenticate));

  app.post(MCP_PATHS, async (req, res) => {
    const agentId = res.locals.agentId as string;

    const server = createServer({ agentId, services });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp request failed]", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get(MCP_PATHS, methodNotAllowed);
  app.delete(MCP_PATHS, methodNotAllowed);
  return app;
}
