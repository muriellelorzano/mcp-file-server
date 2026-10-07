## Setup

```bash
mkdir mcp-workspace && cd mcp-workspace
git init
npm init -y
npm i @modelcontextprotocol/sdk express zod@3
npm i -D typescript tsx @types/node @types/express

mkdir -p src/{transport,tools,core} test logs
mkdir -p workspace/src
echo "# hello workspace" > workspace/README.md
echo "export const x = 1;" > workspace/src/index.ts
```

## `package.json` (edit these fields)

```json
{
  "name": "mcp-workspace",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/index.js",
    "typecheck": "tsc --noEmit"
  }
}
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

## `.env.example` (copy to `.env`)

```bash
PORT=3000
WORKSPACE_ROOT=./workspace
MAX_LIST_ENTRIES=500
```

## `.gitignore`

```
node_modules
dist
.env
logs/
workspace/
```

---

## `src/core/errors.ts`

```ts
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SandboxError extends AppError {}
export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class TooLargeError extends AppError {}
export class InvalidContentError extends AppError {}
```

## `src/config.ts`

```ts
import path from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  MAX_LIST_ENTRIES: z.coerce.number().int().min(1).default(500),
});

export type Config = Readonly<{
  port: number;
  workspaceRoot: string;
  limits: Readonly<{ maxListEntries: number }>;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return Object.freeze({
    port: e.PORT,
    workspaceRoot: path.resolve(e.WORKSPACE_ROOT),
    limits: Object.freeze({ maxListEntries: e.MAX_LIST_ENTRIES }),
  });
}
```

## `src/core/sandbox.ts` (minimal; hardened and fully tested in M2)

```ts
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { NotFoundError, SandboxError } from "./errors.js";

const DENIED = (seg: string) =>
  seg === ".git" || seg === ".env" || seg.startsWith(".env.") || seg === "node_modules";

export type Sandbox = ReturnType<typeof createSandbox>;

export function createSandbox(rootInput: string) {
  // realpath once so every later comparison uses the same canonical root
  const root = realpathSync(path.resolve(rootInput));

  const inside = (p: string) => p === root || p.startsWith(root + path.sep);

  async function resolveSafePath(
    rel: string,
    opts: { mustExist?: boolean } = {},
  ): Promise<string> {
    if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) {
      throw new SandboxError("Path not allowed: invalid path");
    }
    if (rel.includes("\0")) {
      throw new SandboxError("Path not allowed: null byte");
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new SandboxError("Path not allowed: absolute paths are rejected");
    }

    const candidate = path.resolve(root, rel);
    if (!inside(candidate)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }

    const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
    if (segments.some(DENIED)) {
      throw new SandboxError("Path not allowed: protected location");
    }

    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (opts.mustExist) throw new NotFoundError(`Not found: ${rel}`);
      // new file: resolve the parent instead, then re-attach the basename
      try {
        const parent = await fs.realpath(path.dirname(candidate));
        real = path.join(parent, path.basename(candidate));
      } catch {
        throw new NotFoundError(`Not found: parent of ${rel}`);
      }
    }

    // re-check after symlink resolution
    if (!inside(real)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }
    return real;
  }

  function toRelative(abs: string): string {
    const rel = path.relative(root, abs);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  return { root, resolveSafePath, toRelative, isDenied: DENIED };
}
```

## `src/core/fsOps.ts` (list only for M1)

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, SandboxError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";

export type Entry = {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
};

export type ListResult = { entries: Entry[]; truncated: boolean };

export type FsOps = ReturnType<typeof createFsOps>;

export function createFsOps(deps: {
  sandbox: Sandbox;
  limits: { maxListEntries: number };
}) {
  const { sandbox, limits } = deps;

  async function list(rel = ".", recursive = false): Promise<ListResult> {
    const start = await sandbox.resolveSafePath(rel, { mustExist: true });

    const stat = await fs.stat(start);
    if (!stat.isDirectory()) {
      throw new SandboxError(`Not a directory: ${rel}`);
    }

    const entries: Entry[] = [];
    const queue: string[] = [start];
    let truncated = false;

    while (queue.length > 0) {
      const dir = queue.shift()!;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const d of dirents) {
        if (sandbox.isDenied(d.name)) continue;
        if (d.isSymbolicLink()) continue; // never follow links while listing

        if (entries.length >= limits.maxListEntries) {
          truncated = true;
          queue.length = 0;
          break;
        }

        const abs = path.join(dir, d.name);
        const s = await fs.stat(abs).catch(() => null);
        if (!s) continue; // vanished between readdir and stat

        if (d.isDirectory()) {
          entries.push({
            path: sandbox.toRelative(abs),
            type: "dir",
            size: 0,
            mtime: s.mtime.toISOString(),
          });
          if (recursive) queue.push(abs);
        } else if (d.isFile()) {
          entries.push({
            path: sandbox.toRelative(abs),
            type: "file",
            size: s.size,
            mtime: s.mtime.toISOString(),
          });
        }
      }
    }

    return { entries, truncated };
  }

  return { list };
}
```

## `src/core/services.ts`

```ts
import type { Config } from "../config.js";
import { createFsOps } from "./fsOps.js";
import { createSandbox } from "./sandbox.js";

export type Services = ReturnType<typeof createServices>;

export function createServices(cfg: Config) {
  const sandbox = createSandbox(cfg.workspaceRoot);
  const fs = createFsOps({ sandbox, limits: cfg.limits });
  return { fs };
}
```

---

## `src/tools/context.ts`

```ts
import type { Services } from "../core/services.js";

export type ToolContext = {
  agentId: string;
  services: Services;
};
```

## `src/tools/schemas.ts`

```ts
import { z } from "zod";

export const relPath = z.string().min(1).max(512);
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const agentId = z.string().regex(/^[a-z0-9-]{1,32}$/);
```

## `src/tools/result.ts` (maps core errors to MCP results)

```ts
import { AppError } from "../core/errors.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  if (err instanceof AppError) {
    return { isError: true, content: [{ type: "text", text: err.message }] };
  }
  // unexpected: log fully on the server, keep the agent-facing message generic
  console.error("[internal error]", err);
  return { isError: true, content: [{ type: "text", text: "Internal error" }] };
}
```

## `src/tools/files.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";
import { relPath } from "./schemas.js";

export function registerFileTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files and directories inside the shared workspace. Paths are relative to the workspace root.",
      inputSchema: {
        path: relPath.default(".").describe("Directory to list, relative to the workspace root"),
        recursive: z.boolean().default(false).describe("Include nested directories"),
      },
    },
    async ({ path, recursive }) => {
      try {
        const result = await ctx.services.fs.list(path, recursive);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
```

## `src/tools/index.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerFileTools } from "./files.js";

export function registerAllTools(server: McpServer, ctx: ToolContext) {
  registerFileTools(server, ctx);
  // M4: registerHandoffTools(server, ctx);
  // M4: registerGitTools(server, ctx);
}
```

---

## `src/transport/createServer.ts`

```ts
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
```

## `src/transport/app.ts`

```ts
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Services } from "../core/services.js";
import { createServer } from "./createServer.js";

export function createApp(services: Services) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Stateless Streamable HTTP: fresh server + transport per request
  app.post("/mcp", async (req, res) => {
    // M3: replace with the agentId set by the auth middleware
    const agentId = "anonymous";

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

  // Stateless mode has no server-initiated stream or session to delete
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
```

## `src/index.ts`

```ts
import { loadConfig } from "./config.js";
import { createServices } from "./core/services.js";
import { createApp } from "./transport/app.js";

const config = loadConfig();
const services = createServices(config);
const app = createApp(services);

// bind to localhost only; ngrok reaches it locally in M3
app.listen(config.port, "127.0.0.1", () => {
  console.log(`mcp-workspace listening on http://127.0.0.1:${config.port}/mcp`);
  console.log(`workspace root: ${config.workspaceRoot}`);
});
```

---

## Run it

```bash
cp .env.example .env
npm run typecheck
npm run dev
```

Quick smoke test with curl:

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then in MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI, set:
- **Transport Type:** Streamable HTTP
- **URL:** `http://127.0.0.1:3000/mcp`
- Click **Connect**, open **Tools**, run `list_files` with `{}` and then `{ "path": "src", "recursive": true }`.

Escape check you can already try (it should come back as an error, not a listing):

```json
{ "path": "../" }
```

## M1 done when

- `npm run typecheck` passes.
- Inspector connects and lists `list_files`.
- `list_files` returns `README.md` and `src/` from `workspace/`.
- `../` and `/etc` return `Path not allowed` errors.

## Notes

- The SDK's API shifts between versions. If `registerTool` is missing in your installed version, use `server.tool("list_files", "<description>", { path: ..., recursive: ... }, handler)` instead.
- Pin the version once it works: `npm ls @modelcontextprotocol/sdk`.
- The `anonymous` agent ID and the missing audit log are placeholders. Auth lands in M3 and the audit log in M4.

When this runs in Inspector, I can move on to M2: the full sandbox with its test suite, then the remaining file tools.