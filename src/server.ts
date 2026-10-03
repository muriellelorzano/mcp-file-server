import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ops } from "./ops.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

/** Wrap a handler so thrown errors become MCP tool errors (visible to the model) instead of crashing. */
const safe = <A>(fn: (a: A) => unknown | Promise<unknown>) => async (args: A): Promise<ToolResult> => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
  }
};

const relPath = z.string().min(1).max(500).describe("Path relative to the workspace root, e.g. 'src/app.ts'");
const version = z.string().regex(/^[0-9a-f]{16}$|^absent$/).optional()
  .describe("Optimistic lock: the `version` returned by your last read/write of this file. Write is refused if the file changed since.");

export function buildServer(ops: Ops): McpServer {
  const server = new McpServer({ name: "workspace-file-server", version: "1.0.0" });

  // ---- file tools ----
  server.registerTool("list_files", {
    title: "List files",
    description: "List files and folders in a workspace directory. Folders end with '/'.",
    inputSchema: { path: relPath.default("."), recursive: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, safe(({ path, recursive }) => ops.listFiles(path, recursive)));

  server.registerTool("read_file", {
    title: "Read file",
    description: "Read a UTF-8 text file. Returns content and a `version` hash usable with if_version.",
    inputSchema: { path: relPath },
    annotations: { readOnlyHint: true },
  }, safe(({ path }) => ops.readFile(path)));

  server.registerTool("write_file", {
    title: "Write file",
    description: "Create or overwrite a file (parent folders are created). Max 1 MB. Cannot write to .git or the append-only handoff logs.",
    inputSchema: { path: relPath, content: z.string(), if_version: version },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, safe(({ path, content, if_version }) => ops.writeFile(path, content, if_version)));

  server.registerTool("str_replace", {
    title: "Replace text in file",
    description: "Replace exactly one occurrence of old_str with new_str. Fails if old_str is missing or appears more than once.",
    inputSchema: { path: relPath, old_str: z.string().min(1), new_str: z.string(), if_version: version },
    annotations: { destructiveHint: true },
  }, safe(({ path, old_str, new_str, if_version }) => ops.strReplace(path, old_str, new_str, if_version)));

  server.registerTool("delete_file", {
    title: "Delete file",
    description: "Delete a single file (not directories). Handoff files are protected.",
    inputSchema: { path: relPath },
    annotations: { destructiveHint: true },
  }, safe(({ path }) => ops.deleteFile(path)));

  server.registerTool("search_files", {
    title: "Search text",
    description: "Case-insensitive substring search across text files. Returns file, line number, and the matching line.",
    inputSchema: { query: z.string().min(1).max(200), path: relPath.default("."), max_results: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true },
  }, safe(({ query, path, max_results }) => ops.searchFiles(query, path, max_results)));

  // ---- handoff protocol ----
  server.registerTool("handoff_read", {
    title: "Read handoff files",
    description: "START OF EVERY SESSION: returns PROJECT_STATE, PLAN_LOG, CHECKPOINTS and DECISIONS so you can resume where the last session stopped.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, safe(() => ops.handoffRead()));

  server.registerTool("handoff_append", {
    title: "Append to handoff log",
    description: "Add a timestamped entry to PLAN_LOG, CHECKPOINTS or DECISIONS (append-only). Update PROJECT_STATE.md with write_file.",
    inputSchema: {
      log: z.enum(["PLAN_LOG", "CHECKPOINTS", "DECISIONS"]),
      entry: z.string().min(1).max(5000),
      author: z.string().max(50).default("agent").describe("Who is writing, e.g. 'claude-session-1'"),
    },
    annotations: { destructiveHint: false },
  }, safe(({ log, entry, author }) => ops.handoffAppend(log, entry, author)));

  // ---- git-lite ----
  server.registerTool("git_status", {
    title: "Git status", description: "Short git status of the workspace.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, safe(() => ops.gitStatus()));

  server.registerTool("git_diff", {
    title: "Git diff", description: "Diff of uncommitted changes versus HEAD, optionally for one path.",
    inputSchema: { path: relPath.optional() }, annotations: { readOnlyHint: true },
  }, safe(({ path }) => ops.gitDiff(path)));

  server.registerTool("git_log", {
    title: "Git log", description: "Most recent commits (one line each).",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) }, annotations: { readOnlyHint: true },
  }, safe(({ limit }) => ops.gitLog(limit)));

  server.registerTool("git_commit", {
    title: "Git commit", description: "Stage everything and commit. Use at the end of a work block, then record a CHECKPOINT.",
    inputSchema: { message: z.string().min(1).max(200) },
  }, safe(({ message }) => ops.gitCommit(message)));

  return server;
}
