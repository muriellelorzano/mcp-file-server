import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Ops } from "./ops.js";
import { buildServer } from "./server.js";

function tokenOk(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b); // constant-time, equal length
}

export function createApp(ops: Ops, authToken: string) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => { res.json({ ok: true }); });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
    if (!m || !tokenOk(m[1], authToken)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  };

  // Stateless Streamable HTTP: a fresh server+transport per request.
  // All durable state lives on disk, which is what makes cross-session handoff work.
  app.post("/mcp", auth, async (req, res) => {
    const server = buildServer(ops);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP error:", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", auth, notAllowed);
  app.delete("/mcp", auth, notAllowed);
  return app;
}
