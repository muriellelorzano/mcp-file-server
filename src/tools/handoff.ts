import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HANDOFF_ID, HANDOFF_STATUSES } from "../core/handoffStore.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

const relPath = z.string().min(1).max(512);
const agentIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);
const item = z.string().min(1).max(300);

export function registerHandoffTools(server: McpServer, ctx: ToolContext) {
  const handoff = ctx.services.handoff;

  server.registerTool(
    "write_handoff",
    {
      title: "Write handoff",
      description:
        "Hand work to another agent. Creates a new handoff file (never edits an old one). The sender is always you. To change status later, write a new handoff.",
      inputSchema: {
        to: agentIdSchema.describe("Recipient agent id"),
        task: z.string().min(1).max(200).describe("One-line description of the task"),
        status: z.enum(HANDOFF_STATUSES),
        done: z.array(item).max(20).default([]),
        next: z.array(item).max(20).default([]),
        open_questions: z.array(item).max(20).default([]),
        files: z.array(relPath).max(20).default([]).describe("Workspace files the recipient should look at"),
      },
    },
    async ({ to, task, status, done, next, open_questions, files }) => {
      try {
        return ok(
          await handoff.write(ctx.agentId, { to, task, status, done, next, openQuestions: open_questions, files }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_handoffs",
    {
      title: "List handoffs",
      description: "List handoffs, newest first. Pass to=<your agent id> to see your inbox.",
      inputSchema: {
        to: agentIdSchema.optional(),
        from: agentIdSchema.optional(),
        status: z.enum(HANDOFF_STATUSES).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ to, from, status, limit }) => {
      try {
        return ok(await handoff.list({ to, from, status, limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_handoff",
    {
      title: "Read handoff",
      description: "Read one handoff by id (from list_handoffs or write_handoff).",
      inputSchema: { id: z.string().regex(HANDOFF_ID) },
    },
    async ({ id }) => {
      try {
        return ok(await handoff.read(id));
      } catch (err) {
        return fail(err);
      }
    },
  );
}