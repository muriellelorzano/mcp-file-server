import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

const LOGGED_ARGS = ["path", "from", "to", "id", "query", "status", "limit", "staged", "paths"] as const;

function pickArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of LOGGED_ARGS) {
    const v = src[key];
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (Array.isArray(v)) {
      out[key] = v.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 200));
    }
  }
  return out;
}

type Handler = (...args: any[]) => unknown;
type RegisterTool = (name: string, config: unknown, handler: Handler) => unknown;

/** Call BEFORE any registerTool. Wraps registerTool so every handler is audited. */
export function withAudit(server: McpServer, ctx: ToolContext): void {
  const original = (server.registerTool as unknown as RegisterTool).bind(server);

  (server as unknown as { registerTool: RegisterTool }).registerTool = (name, config, handler) =>
    original(name, config, async (...args: unknown[]) => {
      const started = Date.now();
      let result: any;
      let thrown: unknown;
      try {
        result = await handler(...args);
      } catch (err) {
        thrown = err;
      }
      ctx.services.audit.record({
        agent: ctx.agentId,
        tool: name,
        ok: !thrown && !result?.isError,
        ms: Date.now() - started,
        error: thrown ? "Thrown" : result?._meta?.errorType,
        args: pickArgs(args[0]),
      });
      if (thrown) throw thrown;
      return result;
    });
}