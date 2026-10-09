import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  ListFilesSchema,
  ReadFileSchema,
  WriteFileSchema,
  EditFileSchema,
  MoveFileSchema,
  DeleteFileSchema,
  SearchFilesSchema,
} from "./schemas.js";
import {
  listFiles,
  readFile,
  writeFile,
  editFile,
  moveFile,
  deleteFile,
  searchFiles,
} from "./files.js";
import { registerGitTools } from "./git.js";
import { registerHandoffTools } from "./handoff.js";
import { withAudit } from "./instrument.js";
import { fail, ok } from "./result.js";

// Success -> JSON text. Any thrown error -> readable error result (not a protocol crash).
// fail() tags the error class so the audit log can record SandboxError, ConflictError, etc.
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  const { services } = ctx;

  // must run first: it wraps registerTool, so only tools registered after it are audited
  withAudit(server, ctx);

  server.registerTool(
    "list_files",
    {
      description: "List files and directories in the workspace.",
      inputSchema: ListFilesSchema.shape,
    },
    (args) => run(() => listFiles(args, services)),
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a text file and return its content and sha256.",
      inputSchema: ReadFileSchema.shape,
    },
    (args) => run(() => readFile(args, services)),
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Create or overwrite a file. Overwrite requires expected_sha256.",
      inputSchema: WriteFileSchema.shape,
    },
    (args) => run(() => writeFile(args, services)),
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace exactly one occurrence of old_string in a file.",
      inputSchema: EditFileSchema.shape,
    },
    (args) => run(() => editFile(args, services)),
  );

  server.registerTool(
    "move_file",
    {
      description: "Move a file without overwriting the destination.",
      inputSchema: MoveFileSchema.shape,
    },
    (args) => run(() => moveFile(args, services)),
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete a file. Requires the correct expected_sha256.",
      inputSchema: DeleteFileSchema.shape,
    },
    (args) => run(() => deleteFile(args, services)),
  );

  server.registerTool(
    "search_files",
    {
      description: "Case-insensitive text search with line numbers.",
      inputSchema: SearchFilesSchema.shape,
    },
    (args) => run(() => searchFiles(args, services)),
  );

  // M4
  registerHandoffTools(server, ctx);
  registerGitTools(server, ctx);
}