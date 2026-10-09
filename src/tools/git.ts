import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

const relPath = z.string().min(1).max(512);

export function registerGitTools(server: McpServer, ctx: ToolContext) {
  const git = ctx.services.git;

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Show the current branch and changed or untracked files in the workspace.",
    },
    async () => {
      try {
        return ok(await git.status());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Show uncommitted changes to tracked files (use git_status for new files). Set staged=true for staged changes.",
      inputSchema: {
        path: relPath.optional().describe("Limit the diff to one path"),
        staged: z.boolean().default(false),
      },
    },
    async ({ path, staged }) => {
      try {
        return ok(await git.diff(path, staged));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "git_commit",
    {
      title: "Git commit",
      description:
        "Commit workspace changes under your agent identity. Without paths, commits everything that changed.",
      inputSchema: {
        message: z.string().min(1).max(200),
        paths: z.array(relPath).max(50).optional().describe("Commit only these paths"),
      },
    },
    async ({ message, paths }) => {
      try {
        return ok(await git.commit(ctx.agentId, message, paths));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description: "Show recent commits, newest first, with the agent that made each one.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        path: relPath.optional(),
      },
    },
    async ({ limit, path }) => {
      try {
        return ok(await git.log(limit, path));
      } catch (err) {
        return fail(err);
      }
    },
  );
}