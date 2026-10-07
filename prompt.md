## Install

```bash
npm i -D vitest dependency-cruiser
mkdir -p test/core test/tools
```

## `package.json` (add scripts)

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "deps": "depcruise src --config .dependency-cruiser.cjs"
  }
}
```

## `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
```

## `.env.example` (replace)

```bash
PORT=3000
WORKSPACE_ROOT=./workspace
MAX_LIST_ENTRIES=500
MAX_FILE_BYTES=262144
MAX_READ_BYTES=524288
MAX_SEARCH_FILES=2000
LOCK_TIMEOUT_MS=3000
```

---

## `src/core/errors.ts` (replace)

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
export class LockTimeoutError extends AppError {}
```

## `src/config.ts` (replace)

```ts
import path from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  MAX_LIST_ENTRIES: z.coerce.number().int().min(1).default(500),
  MAX_FILE_BYTES: z.coerce.number().int().min(1).default(262_144),
  MAX_READ_BYTES: z.coerce.number().int().min(1).default(524_288),
  MAX_SEARCH_FILES: z.coerce.number().int().min(1).default(2000),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(3000),
});

export type Limits = Readonly<{
  maxListEntries: number;
  maxFileBytes: number;
  maxReadBytes: number;
  maxSearchFiles: number;
  lockTimeoutMs: number;
}>;

export type Config = Readonly<{
  port: number;
  workspaceRoot: string;
  limits: Limits;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return Object.freeze({
    port: e.PORT,
    workspaceRoot: path.resolve(e.WORKSPACE_ROOT),
    limits: Object.freeze({
      maxListEntries: e.MAX_LIST_ENTRIES,
      maxFileBytes: e.MAX_FILE_BYTES,
      maxReadBytes: e.MAX_READ_BYTES,
      maxSearchFiles: e.MAX_SEARCH_FILES,
      lockTimeoutMs: e.LOCK_TIMEOUT_MS,
    }),
  });
}
```

---

## `src/core/sandbox.ts` (replace, full hardening)

```ts
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { NotFoundError, SandboxError } from "./errors.js";

const MAX_PATH_LENGTH = 512;
const MAX_DEPTH = 12;
const HANDOFF_DIR = ".handoffs";

// case-insensitive so ".GIT" is blocked on case-insensitive filesystems
const isDenied = (seg: string): boolean => {
  const s = seg.toLowerCase();
  return s === ".git" || s === ".env" || s.startsWith(".env.") || s === "node_modules";
};

export type ResolveOpts = {
  /** Target must already exist (reads, edits, deletes). */
  mustExist?: boolean;
  /** Operation modifies the workspace. Blocks .handoffs/ (handoff tools only). */
  write?: boolean;
  /** Allow the workspace root itself (listing, searching). */
  allowRoot?: boolean;
};

export type Sandbox = ReturnType<typeof createSandbox>;

export function createSandbox(rootInput: string) {
  // canonical root, computed once
  const root = realpathSync(path.resolve(rootInput));
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);
  const segmentsOf = (abs: string) => path.relative(root, abs).split(path.sep).filter(Boolean);

  function checkSegments(segs: string[], opts: ResolveOpts) {
    if (segs.some(isDenied)) {
      throw new SandboxError("Path not allowed: protected location");
    }
    if (opts.write && segs[0] === HANDOFF_DIR) {
      throw new SandboxError("Path not allowed: .handoffs is managed by handoff tools");
    }
  }

  async function resolveSafePath(rel: string, opts: ResolveOpts = {}): Promise<string> {
    // 1. shape checks
    if (typeof rel !== "string" || rel.length === 0 || rel.length > MAX_PATH_LENGTH) {
      throw new SandboxError("Path not allowed: invalid path");
    }
    if (rel.includes("\0")) {
      throw new SandboxError("Path not allowed: null byte");
    }
    if (rel.includes("\\")) {
      throw new SandboxError("Path not allowed: backslashes are rejected");
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new SandboxError("Path not allowed: absolute paths are rejected");
    }

    // 2. lexical containment
    const candidate = path.resolve(root, rel);
    if (!inside(candidate)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }

    const segs = segmentsOf(candidate);
    if (segs.length === 0 && !opts.allowRoot) {
      throw new SandboxError("Path not allowed: workspace root");
    }
    if (segs.length > MAX_DEPTH) {
      throw new SandboxError("Path not allowed: too deep");
    }
    checkSegments(segs, opts);

    // 3. symlink resolution: find the deepest existing ancestor and realpath it
    let probe = candidate;
    const tail: string[] = [];
    let base: string;
    for (;;) {
      try {
        base = await fs.realpath(probe);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw new SandboxError("Path not allowed: symlink loop");
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;

        // entry exists but realpath failed => dangling symlink; never write through it
        const entry = await fs.lstat(probe).catch(() => null);
        if (entry) throw new SandboxError("Path not allowed: dangling symlink");

        tail.unshift(path.basename(probe));
        const up = path.dirname(probe);
        if (up === probe) throw new NotFoundError(`Not found: ${rel}`);
        probe = up;
      }
    }

    if (opts.mustExist && tail.length > 0) {
      throw new NotFoundError(`Not found: ${rel}`);
    }

    // 4. re-check everything on the resolved path (defeats symlinks)
    const real = path.join(base, ...tail);
    if (!inside(real)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }
    const realSegs = segmentsOf(real);
    if (realSegs.length === 0 && !opts.allowRoot) {
      throw new SandboxError("Path not allowed: workspace root");
    }
    checkSegments(realSegs, opts);

    return real;
  }

  function toRelative(abs: string): string {
    const rel = path.relative(root, abs);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  return { root, resolveSafePath, toRelative, isDenied };
}
```

## `src/core/guards.ts`

```ts
import crypto from "node:crypto";
import { ConflictError, InvalidContentError, TooLargeError } from "./errors.js";

export function sha256Of(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Returns decoded text, or throws if the bytes are binary / not valid UTF-8. */
export function assertText(buf: Buffer): string {
  if (buf.includes(0)) {
    throw new InvalidContentError("Binary content is not allowed (null byte found)");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new InvalidContentError("Content is not valid UTF-8 text");
  }
}

export function assertSize(bytes: number, max: number): void {
  if (bytes > max) {
    throw new TooLargeError(`Content is ${bytes} bytes; the limit is ${max}`);
  }
}

export function checkHash(expected: string, current: string): void {
  if (expected !== current) {
    throw new ConflictError(
      `File changed since you read it (current sha256: ${current}). Re-read the file and retry.`,
    );
  }
}
```

## `src/core/locks.ts`

```ts
import { LockTimeoutError } from "./errors.js";

export type Locks = ReturnType<typeof createLocks>;

export function createLocks(timeoutMs: number) {
  const tails = new Map<string, Promise<void>>();

  async function acquire(key: string): Promise<() => void> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LockTimeoutError("File busy, retry")), timeoutMs);
    });

    try {
      await Promise.race([prev, timeout]);
    } catch (err) {
      release(); // don't block the queue behind a waiter that gave up
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return release;
  }

  /** Runs fn while holding every key. Keys are taken in sorted order to avoid deadlock. */
  async function withLock<T>(keys: string | string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(Array.isArray(keys) ? keys : [keys])].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of sorted) releases.push(await acquire(key));
      return await fn();
    } finally {
      for (const r of releases.reverse()) r();
    }
  }

  return { withLock };
}
```

## `src/core/fsOps.ts` (replace)

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Limits } from "../config.js";
import {
  ConflictError,
  InvalidContentError,
  NotFoundError,
  SandboxError,
  TooLargeError,
} from "./errors.js";
import { assertSize, assertText, checkHash, sha256Of } from "./guards.js";
import type { Locks } from "./locks.js";
import type { Sandbox } from "./sandbox.js";

export type Entry = { path: string; type: "file" | "dir"; size: number; mtime: string };
export type ListResult = { entries: Entry[]; truncated: boolean };
export type SearchMatch = { path: string; line: number; text: string };
export type SearchResult = { matches: SearchMatch[]; truncated: boolean };

export type FsOps = ReturnType<typeof createFsOps>;

export function createFsOps(deps: { sandbox: Sandbox; locks: Locks; limits: Limits }) {
  const { sandbox, locks, limits } = deps;

  // ---------- helpers ----------

  async function statOrNull(p: string) {
    try {
      return await fs.stat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function readBuf(abs: string, rel: string): Promise<Buffer> {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new InvalidContentError(`Not a regular file: ${rel}`);
    if (st.size > limits.maxReadBytes) {
      throw new TooLargeError(`File is ${st.size} bytes; the read limit is ${limits.maxReadBytes}`);
    }
    return fs.readFile(abs);
  }

  async function mkdirParents(abs: string) {
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR" || code === "EEXIST") {
        throw new SandboxError("Path not allowed: parent is not a directory");
      }
      throw err;
    }
  }

  // write to a temp file in the same directory, then rename (atomic on POSIX)
  async function atomicWrite(abs: string, data: Buffer) {
    const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(6).toString("hex")}`);
    try {
      await fs.writeFile(tmp, data, { flag: "wx", mode: 0o644 });
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async function* walk(start: string, recursive: boolean) {
    const queue = [start];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (sandbox.isDenied(d.name) || d.isSymbolicLink()) continue;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          yield { abs, type: "dir" as const };
          if (recursive) queue.push(abs);
        } else if (d.isFile()) {
          yield { abs, type: "file" as const };
        }
      }
    }
  }

  // ---------- read-only ----------

  async function list(rel = ".", recursive = false): Promise<ListResult> {
    const start = await sandbox.resolveSafePath(rel, { mustExist: true, allowRoot: true });
    const st = await fs.stat(start);
    if (!st.isDirectory()) throw new InvalidContentError(`Not a directory: ${rel}`);

    const entries: Entry[] = [];
    let truncated = false;

    for await (const item of walk(start, recursive)) {
      if (entries.length >= limits.maxListEntries) {
        truncated = true;
        break;
      }
      const s = await fs.stat(item.abs).catch(() => null);
      if (!s) continue; // vanished between readdir and stat
      entries.push({
        path: sandbox.toRelative(item.abs),
        type: item.type,
        size: item.type === "file" ? s.size : 0,
        mtime: s.mtime.toISOString(),
      });
    }
    return { entries, truncated };
  }

  async function read(rel: string, offset = 0, length?: number) {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true });
    const buf = await readBuf(abs, rel);
    const text = assertText(buf);
    const end = length === undefined ? text.length : offset + length;
    const content = text.slice(offset, end);
    return {
      path: sandbox.toRelative(abs),
      content,
      sha256: sha256Of(buf), // hash of the FULL file, even for partial reads
      size: buf.length,
      offset,
      truncated: offset + content.length < text.length,
    };
  }

  async function search(query: string, rel = ".", maxResults = 50): Promise<SearchResult> {
    const start = await sandbox.resolveSafePath(rel, { mustExist: true, allowRoot: true });
    const st = await fs.stat(start);
    const limit = Math.min(maxResults, 100);
    const needle = query.toLowerCase();

    async function* files() {
      if (st.isFile()) {
        yield start;
        return;
      }
      for await (const item of walk(start, true)) {
        if (item.type === "file") yield item.abs;
      }
    }

    const matches: SearchMatch[] = [];
    let truncated = false;
    let scanned = 0;

    outer: for await (const file of files()) {
      if (++scanned > limits.maxSearchFiles) {
        truncated = true;
        break;
      }
      const s = await fs.stat(file).catch(() => null);
      if (!s || s.size > limits.maxReadBytes) continue;

      let text: string;
      try {
        text = assertText(await fs.readFile(file));
      } catch {
        continue; // binary or unreadable: skip
      }

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break outer;
        }
        matches.push({
          path: sandbox.toRelative(file),
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
      }
    }
    return { matches, truncated };
  }

  // ---------- writes ----------

  async function write(
    rel: string,
    content: string,
    opts: { expectedSha256?: string; createOnly?: boolean } = {},
  ) {
    const data = Buffer.from(content, "utf8");
    assertSize(data.length, limits.maxFileBytes);
    assertText(data);

    const abs = await sandbox.resolveSafePath(rel, { write: true });

    return locks.withLock(abs, async () => {
      const st = await statOrNull(abs);
      let created = true;

      if (st) {
        created = false;
        if (!st.isFile()) throw new InvalidContentError(`Not a regular file: ${rel}`);
        if (opts.createOnly) throw new ConflictError(`File already exists: ${rel}`);
        if (!opts.expectedSha256) {
          throw new ConflictError(
            "expected_sha256 is required to overwrite an existing file (call read_file first)",
          );
        }
        checkHash(opts.expectedSha256, sha256Of(await readBuf(abs, rel)));
      } else if (opts.expectedSha256) {
        throw new ConflictError(`File does not exist but expected_sha256 was given: ${rel}`);
      }

      await mkdirParents(abs);
      await atomicWrite(abs, data);
      return { path: sandbox.toRelative(abs), sha256: sha256Of(data), size: data.length, created };
    });
  }

  async function edit(rel: string, oldStr: string, newStr: string, expectedSha256?: string) {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true, write: true });

    return locks.withLock(abs, async () => {
      const buf = await readBuf(abs, rel);
      const text = assertText(buf);
      if (expectedSha256) checkHash(expectedSha256, sha256Of(buf));

      const first = text.indexOf(oldStr);
      if (first === -1) throw new ConflictError("old_string not found in file");
      // +1 so overlapping matches ("aa" in "aaa") also count as ambiguous
      if (text.indexOf(oldStr, first + 1) !== -1) {
        throw new ConflictError("old_string matches more than once; add more context");
      }

      const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
      const data = Buffer.from(next, "utf8");
      assertSize(data.length, limits.maxFileBytes);
      assertText(data);

      await atomicWrite(abs, data);
      return { path: sandbox.toRelative(abs), sha256: sha256Of(data), replacements: 1 };
    });
  }

  async function move(fromRel: string, toRel: string) {
    const src = await sandbox.resolveSafePath(fromRel, { mustExist: true, write: true });
    const dst = await sandbox.resolveSafePath(toRel, { write: true });
    if (src === dst) throw new ConflictError("Source and destination are the same");

    return locks.withLock([src, dst], async () => {
      const st = await statOrNull(src);
      if (!st) throw new NotFoundError(`Not found: ${fromRel}`);
      if (!st.isFile()) throw new InvalidContentError("Only files can be moved");
      if (await statOrNull(dst)) throw new ConflictError(`Destination already exists: ${toRel}`);

      await mkdirParents(dst);
      await fs.rename(src, dst);
      return { from: sandbox.toRelative(src), to: sandbox.toRelative(dst) };
    });
  }

  async function remove(rel: string, expectedSha256: string) {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true, write: true });

    return locks.withLock(abs, async () => {
      const buf = await readBuf(abs, rel);
      checkHash(expectedSha256, sha256Of(buf));
      await fs.unlink(abs);
      return { path: sandbox.toRelative(abs), deleted: true as const };
    });
  }

  return { list, read, search, write, edit, move, remove };
}
```

## `src/core/services.ts` (replace)

```ts
import type { Config } from "../config.js";
import { createFsOps } from "./fsOps.js";
import { createLocks } from "./locks.js";
import { createSandbox } from "./sandbox.js";

export type Services = ReturnType<typeof createServices>;

export function createServices(cfg: Config) {
  const sandbox = createSandbox(cfg.workspaceRoot);
  const locks = createLocks(cfg.limits.lockTimeoutMs);
  const fs = createFsOps({ sandbox, locks, limits: cfg.limits });
  return { fs };
}
```

---

## `src/tools/files.ts` (replace)

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";
import { relPath, sha256 } from "./schemas.js";

export function registerFileTools(server: McpServer, ctx: ToolContext) {
  const fs = ctx.services.fs;

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List files and directories in the shared workspace. Paths are relative to the workspace root.",
      inputSchema: {
        path: relPath.default(".").describe("Directory to list"),
        recursive: z.boolean().default(false).describe("Include nested directories"),
      },
    },
    async ({ path, recursive }) => {
      try {
        return ok(await fs.list(path, recursive));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file. Returns content and its sha256. Pass that sha256 as expected_sha256 when you later overwrite or delete the file.",
      inputSchema: {
        path: relPath,
        offset: z.number().int().min(0).optional().describe("Character offset to start from"),
        length: z.number().int().min(1).optional().describe("Max characters to return"),
      },
    },
    async ({ path, offset, length }) => {
      try {
        return ok(await fs.read(path, offset, length));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create a file, or overwrite an existing one. Overwriting requires expected_sha256 from a prior read_file. Parent directories are created automatically.",
      inputSchema: {
        path: relPath,
        content: z.string(),
        expected_sha256: sha256.optional().describe("sha256 of the version you read (required to overwrite)"),
        create_only: z.boolean().default(false).describe("Fail if the file already exists"),
      },
    },
    async ({ path, content, expected_sha256, create_only }) => {
      try {
        return ok(
          await fs.write(path, content, {
            expectedSha256: expected_sha256,
            createOnly: create_only,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Replace one exact occurrence of old_string with new_string. Fails if old_string is missing or appears more than once.",
      inputSchema: {
        path: relPath,
        old_string: z.string().min(1),
        new_string: z.string(),
        expected_sha256: sha256.optional(),
      },
    },
    async ({ path, old_string, new_string, expected_sha256 }) => {
      try {
        return ok(await fs.edit(path, old_string, new_string, expected_sha256));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "move_file",
    {
      title: "Move file",
      description: "Move or rename a file. Fails if the destination already exists. Files only.",
      inputSchema: { from: relPath, to: relPath },
    },
    async ({ from, to }) => {
      try {
        return ok(await fs.move(from, to));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description: "Delete a file. Requires expected_sha256 from a prior read_file, so you cannot delete what you have not read.",
      inputSchema: { path: relPath, expected_sha256: sha256 },
    },
    async ({ path, expected_sha256 }) => {
      try {
        return ok(await fs.remove(path, expected_sha256));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Case-insensitive substring search across text files. Returns path, line number and the matching line.",
      inputSchema: {
        query: z.string().min(1).max(200),
        path: relPath.default("."),
        max_results: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ query, path, max_results }) => {
      try {
        return ok(await fs.search(query, path, max_results));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
```

---

## `.dependency-cruiser.cjs`

```js
/** Enforces the import rules from architecture.md section 6. */
module.exports = {
  forbidden: [
    {
      name: "core-must-not-import-upper-layers",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^src/(tools|transport)" },
    },
    {
      name: "core-must-not-import-mcp-sdk",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "@modelcontextprotocol" },
    },
    {
      name: "tools-must-not-import-transport",
      severity: "error",
      from: { path: "^src/tools" },
      to: { path: "^src/transport" },
    },
    {
      name: "tools-must-not-touch-fs-or-processes",
      severity: "error",
      from: { path: "^src/tools" },
      to: { path: "^(node:)?(fs|fs/promises|child_process)$", dependencyTypes: ["core"] },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
  },
};
```

---

## `test/helpers.ts`

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/core/services.js";

/**
 * Layout:  <base>/workspace   <- the sandbox root
 *          <base>/outside     <- a sibling the sandbox must never reach
 */
export async function makeWorkspace(overrides: Record<string, string> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcpws-")));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");

  const config = loadConfig({ WORKSPACE_ROOT: root, ...overrides } as NodeJS.ProcessEnv);
  const services = createServices(config);

  return {
    base,
    root,
    outside,
    config,
    services,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

export type TestWorkspace = Awaited<ReturnType<typeof makeWorkspace>>;
```

## `test/core/sandbox.test.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, SandboxError } from "../../src/core/errors.js";
import { createSandbox, type Sandbox } from "../../src/core/sandbox.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
let sb: Sandbox;

beforeEach(async () => {
  ws = await makeWorkspace();
  sb = createSandbox(ws.root);
  await fs.mkdir(path.join(ws.root, "src"));
  await fs.writeFile(path.join(ws.root, "src", "a.txt"), "hello");
});
afterEach(() => ws.cleanup());

describe("lexical escapes", () => {
  it.each([
    "../outside/secret.txt",
    "../../etc/passwd",
    "foo/../../x",
    "src/../../outside/secret.txt",
  ])("rejects traversal: %s", async (p) => {
    await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
  });

  it.each(["/etc/passwd", "C:\\Windows\\x", "C:/Windows/x", "\\\\server\\share"])(
    "rejects absolute path: %s",
    async (p) => {
      await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
    },
  );

  it("rejects null bytes", async () => {
    await expect(sb.resolveSafePath("a\0b")).rejects.toThrow(SandboxError);
  });

  it("rejects backslashes", async () => {
    await expect(sb.resolveSafePath("src\\..\\..\\x")).rejects.toThrow(SandboxError);
  });

  it("rejects empty and oversized paths", async () => {
    await expect(sb.resolveSafePath("")).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath("a".repeat(513))).rejects.toThrow(SandboxError);
  });

  it("rejects paths deeper than 12 segments", async () => {
    const deep = Array(13).fill("d").join("/") + "/f.txt";
    await expect(sb.resolveSafePath(deep)).rejects.toThrow(SandboxError);
  });

  it("treats encoded dots as literal names that stay inside", async () => {
    const p = await sb.resolveSafePath("%2e%2e/x");
    expect(p.startsWith(ws.root + path.sep)).toBe(true);
  });
});

describe("normalization", () => {
  it.each(["./src/./a.txt", "src//a.txt", "src/../src/a.txt"])("resolves %s inside root", async (p) => {
    const abs = await sb.resolveSafePath(p, { mustExist: true });
    expect(abs).toBe(path.join(ws.root, "src", "a.txt"));
  });
});

describe("protected locations", () => {
  it.each([".git/config", ".GIT/config", ".env", ".env.local", "node_modules/x", "src/.env"])(
    "rejects %s",
    async (p) => {
      await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
    },
  );

  it("blocks writes under .handoffs but allows reads", async () => {
    await expect(sb.resolveSafePath(".handoffs/x.md", { write: true })).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath(".handoffs/x.md")).resolves.toBeTypeOf("string");
  });
});

describe("workspace root", () => {
  it("is rejected unless allowRoot is set", async () => {
    await expect(sb.resolveSafePath(".")).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath(".", { allowRoot: true })).resolves.toBe(ws.root);
  });
});

describe("symlinks", () => {
  it("rejects a symlink to an outside directory", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"));
    await expect(sb.resolveSafePath("link/secret.txt", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a symlink to an outside file", async () => {
    await fs.symlink(path.join(ws.outside, "secret.txt"), path.join(ws.root, "s.txt"));
    await expect(sb.resolveSafePath("s.txt", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a NEW file under a symlinked parent that points outside", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"));
    await expect(sb.resolveSafePath("link/new.txt", { write: true })).rejects.toThrow(SandboxError);
  });

  it("rejects writing through a dangling symlink", async () => {
    await fs.symlink(path.join(ws.outside, "does-not-exist.txt"), path.join(ws.root, "dangling"));
    await expect(sb.resolveSafePath("dangling", { write: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a symlink loop", async () => {
    await fs.symlink(path.join(ws.root, "b"), path.join(ws.root, "a"));
    await fs.symlink(path.join(ws.root, "a"), path.join(ws.root, "b"));
    await expect(sb.resolveSafePath("a", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects an in-workspace symlink that points at .git", async () => {
    await fs.mkdir(path.join(ws.root, ".git"));
    await fs.writeFile(path.join(ws.root, ".git", "config"), "x");
    await fs.symlink(path.join(ws.root, ".git"), path.join(ws.root, "sneaky"));
    await expect(sb.resolveSafePath("sneaky/config", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await fs.symlink(path.join(ws.root, "src"), path.join(ws.root, "alias"));
    const abs = await sb.resolveSafePath("alias/a.txt", { mustExist: true });
    expect(abs).toBe(path.join(ws.root, "src", "a.txt"));
  });
});

describe("existence", () => {
  it("throws NotFoundError when mustExist and missing", async () => {
    await expect(sb.resolveSafePath("nope.txt", { mustExist: true })).rejects.toThrow(NotFoundError);
  });

  it("allows a new file in a missing directory when not mustExist", async () => {
    const abs = await sb.resolveSafePath("new/dir/file.txt", { write: true });
    expect(abs).toBe(path.join(ws.root, "new", "dir", "file.txt"));
  });

  it("does not leak the host path in error messages", async () => {
    const err = await sb.resolveSafePath("../outside/secret.txt").catch((e: Error) => e);
    expect((err as Error).message).not.toContain(ws.base);
  });
});
```

## `test/core/guards.test.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, InvalidContentError, TooLargeError } from "../../src/core/errors.js";
import { sha256Of } from "../../src/core/guards.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace({ MAX_FILE_BYTES: "100" });
});
afterEach(() => ws.cleanup());

const fsOps = () => ws.services.fs;

describe("write_file guards", () => {
  it("creates a new file and returns its hash", async () => {
    const r = await fsOps().write("a.txt", "hello");
    expect(r).toMatchObject({ path: "a.txt", created: true, size: 5, sha256: sha256Of("hello") });
  });

  it("creates parent directories", async () => {
    await fsOps().write("x/y/z.txt", "deep");
    expect(await fs.readFile(path.join(ws.root, "x/y/z.txt"), "utf8")).toBe("deep");
  });

  it("rejects overwrite without expected_sha256", async () => {
    await fsOps().write("a.txt", "v1");
    await expect(fsOps().write("a.txt", "v2")).rejects.toThrow(ConflictError);
  });

  it("rejects overwrite with a stale hash and reports the current one", async () => {
    const v1 = await fsOps().write("a.txt", "v1");
    await fsOps().write("a.txt", "v2", { expectedSha256: v1.sha256 }); // agent B wins
    const err = await fsOps()
      .write("a.txt", "v3", { expectedSha256: v1.sha256 }) // agent A is stale
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain(sha256Of("v2"));
    expect(await fs.readFile(path.join(ws.root, "a.txt"), "utf8")).toBe("v2");
  });

  it("accepts overwrite with the right hash", async () => {
    const v1 = await fsOps().write("a.txt", "v1");
    const v2 = await fsOps().write("a.txt", "v2", { expectedSha256: v1.sha256 });
    expect(v2.created).toBe(false);
  });

  it("rejects create_only on an existing file", async () => {
    await fsOps().write("a.txt", "v1");
    await expect(fsOps().write("a.txt", "v2", { createOnly: true })).rejects.toThrow(ConflictError);
  });

  it("rejects expected_sha256 for a file that does not exist", async () => {
    await expect(fsOps().write("a.txt", "v1", { expectedSha256: sha256Of("x") })).rejects.toThrow(ConflictError);
  });

  it("rejects oversized content", async () => {
    await expect(fsOps().write("big.txt", "x".repeat(101))).rejects.toThrow(TooLargeError);
  });

  it("rejects content with null bytes", async () => {
    await expect(fsOps().write("bin.txt", "a\0b")).rejects.toThrow(InvalidContentError);
  });

  it("leaves no temp files behind", async () => {
    await fsOps().write("a.txt", "hello");
    const names = await fs.readdir(ws.root);
    expect(names.filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });
});

describe("read_file", () => {
  it("returns content and the full-file hash, even for partial reads", async () => {
    await fsOps().write("a.txt", "0123456789");
    const r = await fsOps().read("a.txt", 2, 3);
    expect(r.content).toBe("234");
    expect(r.truncated).toBe(true);
    expect(r.sha256).toBe(sha256Of("0123456789"));
  });

  it("refuses binary files", async () => {
    await fs.writeFile(path.join(ws.root, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await expect(fsOps().read("img.bin")).rejects.toThrow(InvalidContentError);
  });

  it("refuses directories", async () => {
    await fs.mkdir(path.join(ws.root, "d"));
    await expect(fsOps().read("d")).rejects.toThrow(InvalidContentError);
  });
});

describe("edit_file", () => {
  it("replaces exactly one occurrence", async () => {
    await fsOps().write("a.txt", "foo bar baz");
    const r = await fsOps().edit("a.txt", "bar", "QUX");
    expect(await fs.readFile(path.join(ws.root, "a.txt"), "utf8")).toBe("foo QUX baz");
    expect(r.replacements).toBe(1);
  });

  it("rejects when old_string is missing", async () => {
    await fsOps().write("a.txt", "foo");
    await expect(fsOps().edit("a.txt", "nope", "x")).rejects.toThrow(ConflictError);
  });

  it("rejects when old_string is ambiguous, including overlaps", async () => {
    await fsOps().write("a.txt", "foo foo");
    await expect(fsOps().edit("a.txt", "foo", "x")).rejects.toThrow(ConflictError);
    await fsOps().write("b.txt", "aaa");
    await expect(fsOps().edit("b.txt", "aa", "x")).rejects.toThrow(ConflictError);
  });

  it("honours expected_sha256 when given", async () => {
    await fsOps().write("a.txt", "foo");
    await expect(fsOps().edit("a.txt", "foo", "bar", sha256Of("stale"))).rejects.toThrow(ConflictError);
  });
});

describe("move_file and delete_file", () => {
  it("moves a file and creates the destination directory", async () => {
    await fsOps().write("a.txt", "hi");
    const r = await fsOps().move("a.txt", "sub/b.txt");
    expect(r).toEqual({ from: "a.txt", to: "sub/b.txt" });
    expect(await fs.readFile(path.join(ws.root, "sub/b.txt"), "utf8")).toBe("hi");
  });

  it("refuses to clobber an existing destination", async () => {
    await fsOps().write("a.txt", "1");
    await fsOps().write("b.txt", "2");
    await expect(fsOps().move("a.txt", "b.txt")).rejects.toThrow(ConflictError);
  });

  it("refuses to move into .handoffs", async () => {
    await fsOps().write("a.txt", "1");
    await expect(fsOps().move("a.txt", ".handoffs/a.txt")).rejects.toThrow();
  });

  it("deletes only with the right hash", async () => {
    const w = await fsOps().write("a.txt", "bye");
    await expect(fsOps().remove("a.txt", sha256Of("wrong"))).rejects.toThrow(ConflictError);
    await expect(fsOps().remove("a.txt", w.sha256)).resolves.toMatchObject({ deleted: true });
    await expect(fs.stat(path.join(ws.root, "a.txt"))).rejects.toThrow();
  });
});

describe("list_files and search_files", () => {
  it("lists the root and nested directories, hiding protected names", async () => {
    await fsOps().write("src/a.ts", "x");
    await fs.mkdir(path.join(ws.root, ".git"));
    await fs.mkdir(path.join(ws.root, "node_modules"));
    const flat = await fsOps().list(".");
    expect(flat.entries.map((e) => e.path)).toEqual(["src"]);
    const deep = await fsOps().list(".", true);
    expect(deep.entries.map((e) => e.path)).toEqual(["src", "src/a.ts"]);
  });

  it("does not follow symlinks while listing", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"));
    const r = await fsOps().list(".", true);
    expect(r.entries.map((e) => e.path)).not.toContain("link/secret.txt");
  });

  it("finds matches case-insensitively with line numbers", async () => {
    await fsOps().write("a.txt", "one\nTwo TODO here\nthree");
    const r = await fsOps().search("todo");
    expect(r.matches).toEqual([{ path: "a.txt", line: 2, text: "Two TODO here" }]);
  });

  it("skips binary files and truncates at the result limit", async () => {
    await fs.writeFile(path.join(ws.root, "bin.dat"), Buffer.from([0, 1, 2, 116, 111, 100, 111]));
    await fsOps().write("a.txt", "todo\ntodo\ntodo");
    const r = await fsOps().search("todo", ".", 2);
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.matches.every((m) => m.path === "a.txt")).toBe(true);
  });
});
```

## `test/core/locks.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { LockTimeoutError } from "../../src/core/errors.js";
import { createLocks } from "../../src/core/locks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("locks", () => {
  it("serializes work on the same key", async () => {
    const locks = createLocks(1000);
    const log: string[] = [];

    const task = (name: string, ms: number) =>
      locks.withLock("k", async () => {
        log.push(`${name}:start`);
        await sleep(ms);
        log.push(`${name}:end`);
      });

    await Promise.all([task("a", 30), task("b", 1)]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs different keys in parallel", async () => {
    const locks = createLocks(1000);
    const log: string[] = [];
    await Promise.all([
      locks.withLock("x", async () => { log.push("x:start"); await sleep(20); log.push("x:end"); }),
      locks.withLock("y", async () => { log.push("y:start"); await sleep(1); log.push("y:end"); }),
    ]);
    expect(log.slice(0, 2).sort()).toEqual(["x:start", "y:start"]);
  });

  it("times out waiting for a busy key, then recovers", async () => {
    const locks = createLocks(50);
    const holder = locks.withLock("k", () => sleep(200));
    await expect(locks.withLock("k", async () => "never")).rejects.toThrow(LockTimeoutError);
    await holder;
    await expect(locks.withLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("releases the lock when the task throws", async () => {
    const locks = createLocks(500);
    await expect(locks.withLock("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(locks.withLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("does not deadlock when two tasks lock the same pair in opposite order", async () => {
    const locks = createLocks(1000);
    const done = await Promise.all([
      locks.withLock(["a", "b"], async () => { await sleep(10); return 1; }),
      locks.withLock(["b", "a"], async () => { await sleep(10); return 2; }),
    ]);
    expect(done.sort()).toEqual([1, 2]);
  });

  it("lets only one of many concurrent hash-guarded writers win (integration)", async () => {
    const locks = createLocks(1000);
    let value = "v1";
    const attempt = (expected: string, next: string) =>
      locks.withLock("f", async () => {
        await sleep(2);
        if (value !== expected) throw new Error("conflict");
        value = next;
      });

    const results = await Promise.allSettled([attempt("v1", "A"), attempt("v1", "B"), attempt("v1", "C")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
```

## `test/tools/files.test.ts` (through the real MCP protocol, in memory)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/transport/createServer.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  ws = await makeWorkspace();
  const server = createServer({ agentId: "test-agent", services: ws.services });
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});
afterEach(async () => {
  await close();
  await ws.cleanup();
});

// Schema failures may surface as a thrown protocol error or an isError result,
// depending on SDK version. Treat both as "rejected".
async function call(name: string, args: Record<string, unknown>) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: Boolean(r.isError), text };
  } catch (err) {
    return { isError: true, text: String(err) };
  }
}

describe("tool registration", () => {
  it("exposes the M2 file tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_file",
      "edit_file",
      "list_files",
      "move_file",
      "read_file",
      "search_files",
      "write_file",
    ]);
  });
});

describe("happy path", () => {
  it("write -> read -> overwrite with hash -> list", async () => {
    const w = await call("write_file", { path: "notes/a.md", content: "v1" });
    expect(w.isError).toBe(false);

    const r = await call("read_file", { path: "notes/a.md" });
    const { sha256 } = JSON.parse(r.text);

    const w2 = await call("write_file", { path: "notes/a.md", content: "v2", expected_sha256: sha256 });
    expect(w2.isError).toBe(false);

    const l = await call("list_files", { recursive: true });
    expect(JSON.parse(l.text).entries.map((e: { path: string }) => e.path)).toEqual([
      "notes",
      "notes/a.md",
    ]);
  });
});

describe("rejections are returned as readable errors", () => {
  it("blocks path traversal without leaking file contents or host paths", async () => {
    const r = await call("read_file", { path: "../outside/secret.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Path not allowed");
    expect(r.text).not.toContain("top secret");
    expect(r.text).not.toContain(ws.base);
  });

  it("blocks absolute paths on every tool that takes a path", async () => {
    for (const [name, args] of [
      ["list_files", { path: "/etc" }],
      ["read_file", { path: "/etc/passwd" }],
      ["write_file", { path: "/tmp/x", content: "x" }],
      ["search_files", { query: "root", path: "/etc" }],
      ["move_file", { from: "/etc/passwd", to: "x" }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
    }
  });

  it("requires expected_sha256 to overwrite", async () => {
    await call("write_file", { path: "a.txt", content: "v1" });
    const r = await call("write_file", { path: "a.txt", content: "v2" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("expected_sha256");
  });

  it("reports the current hash on a stale write", async () => {
    await call("write_file", { path: "a.txt", content: "v1" });
    const stale = "0".repeat(64);
    const r = await call("write_file", { path: "a.txt", content: "v2", expected_sha256: stale });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("current sha256");
  });

  it("rejects malformed input via zod", async () => {
    expect((await call("write_file", { path: "a.txt" })).isError).toBe(true); // missing content
    expect((await call("read_file", { path: "a.txt", offset: -1 })).isError).toBe(true);
    expect((await call("delete_file", { path: "a.txt", expected_sha256: "nothex" })).isError).toBe(true);
    expect((await call("search_files", { query: "" })).isError).toBe(true);
  });
});
```

---

## Run it

```bash
npm run typecheck
npm test
npm run deps
npm run dev
```

## Manual attack checks in MCP Inspector

```json
// all of these should return "Path not allowed", never file contents
{ "tool": "read_file",   "path": "../README.md" }
{ "tool": "read_file",   "path": "/etc/passwd" }
{ "tool": "read_file",   "path": ".git/config" }
{ "tool": "write_file",  "path": ".env", "content": "x" }
{ "tool": "write_file",  "path": ".handoffs/fake.md", "content": "x" }
{ "tool": "list_files",  "path": "../" }
```

```bash
# symlink attack against the live workspace (then try read_file "escape/hosts")
ln -s /etc workspace/escape
```

```json
// conflict flow: run read_file, then write_file twice with the same expected_sha256
// the second call must fail with "File changed since you read it"
{ "tool": "write_file", "path": "demo.txt", "content": "v1" }
{ "tool": "read_file",  "path": "demo.txt" }
{ "tool": "write_file", "path": "demo.txt", "content": "v2", "expected_sha256": "<hash>" }
{ "tool": "write_file", "path": "demo.txt", "content": "v3", "expected_sha256": "<same hash>" }
```

## M2 done when

- `npm test` is green, including every symlink and traversal case.
- `npm run deps` reports no violations.
- Every tool input has a zod schema (the tool test covers four malformed inputs).
- The Inspector attack checks above all fail safely.

## Notes

- **Windows:** the symlink tests need Developer Mode or admin rights. Skip them there with `it.skipIf(process.platform === "win32")`.
- **Known gap:** there is still a small time gap between checking a path and using it (TOCTOU). The per-file lock and atomic temp-then-rename writes cover concurrent agents inside this process, but not something else modifying the workspace on disk. Document that in your threat model.
- **`dependency-cruiser`:** if the `tools-must-not-touch-fs-or-processes` rule never fires, add a deliberate `import "node:fs"` in a tools file once to confirm it triggers, then remove it.
- **Binary files:** `read_file` and `write_file` refuse them, and `search_files` skips them. That is deliberate for M2.

When the tests pass, I can move on to M3: bearer auth, the pm2 + ngrok config and a real client connection.