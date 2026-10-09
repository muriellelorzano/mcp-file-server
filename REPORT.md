# M4: handoffs, git-lite, audit log

Your M2 code already has the hash check, size cap, text-only check and locks, so there is no new guard code to write. M4 adds the three new pieces and tests that prove the guards over MCP.

## Files at a glance

| File | Action |
|---|---|
| `.env`, `.env.example` | change (3 lines) |
| `src/config.ts` | change (small additions) |
| `src/core/errors.ts` | change (1 line) |
| `src/core/audit.ts` | **new** |
| `src/core/handoffStore.ts` | **new** |
| `src/core/gitRunner.ts` | **new** |
| `src/core/services.ts` | replace |
| `src/tools/result.ts` | replace |
| `src/tools/instrument.ts` | **new** |
| `src/tools/handoff.ts` | **new** |
| `src/tools/git.ts` | **new** |
| `src/tools/index.ts` | replace |
| `src/index.ts` | replace |
| `test/helpers.ts` | change (add to it) |
| `test/core/handoffStore.test.ts`, `gitRunner.test.ts`, `audit.test.ts` | **new** |
| `test/tools/protocol.test.ts` | **new** |
| `test/tools/files.test.ts` | change (1 assertion) |

Git must be installed. Check with `git --version`.

---

## 1. Config

### `.env` and `.env.example` (append)

```bash
AUDIT_PATH=./logs/audit.jsonl
MAX_DIFF_BYTES=100000
GIT_TIMEOUT_MS=10000
```

### `src/config.ts` (add these pieces)

```ts
// 1. inside the Env z.object({ ... }), add:
  AUDIT_PATH: z.string().min(1).default("./logs/audit.jsonl"),
  MAX_DIFF_BYTES: z.coerce.number().int().min(1).default(100_000),
  GIT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

// 2. in the Limits type, add:
  maxDiffBytes: number;
  gitTimeoutMs: number;

// 3. in the Config type, add:
  auditPath: string;

// 4. in loadConfig(), inside limits add these two, and add auditPath beside port:
      maxDiffBytes: e.MAX_DIFF_BYTES,
      gitTimeoutMs: e.GIT_TIMEOUT_MS,
// ...
    auditPath: path.resolve(e.AUDIT_PATH),
```

### `src/core/errors.ts` (add one line)

```ts
export class GitError extends AppError {}
```

---

## 2. Core layer

### `src/core/audit.ts` (new)

```ts
import fs from "node:fs";
import path from "node:path";

export type AuditEntry = {
  agent: string;
  tool: string;
  ok: boolean;
  ms: number;
  error?: string;
  args?: Record<string, unknown>;
};

export type Audit = ReturnType<typeof createAudit>;

/** JSON Lines log. Never throws into the caller: a failed write goes to stderr. */
export function createAudit(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let chain: Promise<unknown> = Promise.resolve();

  function record(entry: AuditEntry): void {
    const { args, ...rest } = entry;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...args, ...rest }) + "\n";
    chain = chain
      .then(() => fs.promises.appendFile(filePath, line, "utf8"))
      .catch((err: Error) => console.error("[audit] write failed:", err.message));
  }

  /** Resolves when every queued record is on disk (tests, shutdown). */
  async function flush(): Promise<void> {
    await chain;
  }

  return { record, flush, path: filePath };
}
```

### `src/core/handoffStore.ts` (new)

Handoffs are append-only. Frontmatter values are JSON-encoded on a single line each, so text inside a field can't fake another field.

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Limits } from "../config.js";
import { ConflictError, InvalidContentError, NotFoundError, TooLargeError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";

export const HANDOFF_DIR = ".handoffs";
export const HANDOFF_STATUSES = ["ready", "blocked", "done"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
export const HANDOFF_ID = /^[a-z0-9-]{1,32}-to-[a-z0-9-]{1,32}-\d{8}T\d{9}Z-[a-f0-9]{4}$/;

const AGENT = /^[a-z0-9-]{1,32}$/;
const MAX_SCAN = 500;
const STAMP = /(\d{8}T\d{9}Z)-[a-f0-9]{4}$/;

const MetaSchema = z
  .object({
    id: z.string().regex(HANDOFF_ID),
    from: z.string().regex(AGENT),
    to: z.string().regex(AGENT),
    status: z.enum(HANDOFF_STATUSES),
    task: z.string().min(1).max(200),
    created: z.string().max(40),
    files: z.array(z.string().max(512)).max(20),
    done: z.array(z.string().max(300)).max(20),
    next: z.array(z.string().max(300)).max(20),
    open_questions: z.array(z.string().max(300)).max(20),
  })
  .strict();

export type HandoffMeta = z.infer<typeof MetaSchema>;

export type HandoffInput = {
  to: string;
  task: string;
  status: HandoffStatus;
  done?: string[];
  next?: string[];
  openQuestions?: string[];
  files?: string[];
};

export type HandoffFilter = { to?: string; from?: string; status?: HandoffStatus; limit?: number };
export type HandoffSummary = Pick<HandoffMeta, "id" | "from" | "to" | "task" | "status" | "created">;

export type HandoffStore = ReturnType<typeof createHandoffStore>;

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function serialize(meta: HandoffMeta): string {
  const front = Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const section = (title: string, items: string[]) =>
    items.length ? `## ${title}\n${items.map((i) => `- ${oneLine(i)}`).join("\n")}\n\n` : "";
  return (
    `---\n${front}\n---\n\n# ${oneLine(meta.task)}\n\n` +
    section("Done", meta.done) +
    section("Next", meta.next) +
    section("Open questions", meta.open_questions) +
    section("Files", meta.files)
  );
}

function parse(text: string): { meta: HandoffMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new InvalidContentError("Malformed handoff: missing frontmatter");
  try {
    const entries: [string, unknown][] = m[1]!.split("\n").map((line) => {
      const i = line.indexOf(": ");
      if (i < 1) throw new Error("bad line");
      return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
    });
    return { meta: MetaSchema.parse(Object.fromEntries(entries)), body: m[2]!.trim() };
  } catch {
    throw new InvalidContentError("Malformed handoff: invalid frontmatter");
  }
}

export function createHandoffStore(deps: {
  sandbox: Sandbox;
  limits: Limits;
  knownAgents: ReadonlySet<string>;
}) {
  const { sandbox, limits, knownAgents } = deps;

  const makeId = (from: string, to: string) =>
    `${from}-to-${to}-${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;

  async function handoffDir() {
    // read access: sandbox only blocks WRITES into .handoffs, which is what we want for file tools
    return sandbox.resolveSafePath(HANDOFF_DIR);
  }

  async function readMeta(file: string) {
    const st = await fs.lstat(file); // lstat: a symlink is never a regular file
    if (!st.isFile()) throw new InvalidContentError("Not a regular file");
    if (st.size > limits.maxFileBytes) throw new TooLargeError("Handoff file too large");
    return parse(await fs.readFile(file, "utf8"));
  }

  const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

  /** `from` always comes from the authenticated agent, never from tool input. */
  async function write(from: string, input: HandoffInput) {
    if (!knownAgents.has(input.to)) throw new NotFoundError(`Unknown recipient: ${input.to}`);

    const files = new Set<string>();
    for (const f of input.files ?? []) {
      files.add(sandbox.toRelative(await sandbox.resolveSafePath(f))); // rejects escapes / protected paths
    }

    const dir = await handoffDir();
    await fs.mkdir(dir, { recursive: true });

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = makeId(from, input.to);
      const candidate: HandoffMeta = {
        id,
        from,
        to: input.to,
        status: input.status,
        task: input.task.trim(),
        created: new Date().toISOString(),
        files: [...files],
        done: input.done ?? [],
        next: input.next ?? [],
        open_questions: input.openQuestions ?? [],
      };
      const checked = MetaSchema.safeParse(candidate);
      if (!checked.success) throw new InvalidContentError("Invalid handoff fields");

      const data = Buffer.from(serialize(checked.data), "utf8");
      if (data.length > limits.maxFileBytes) {
        throw new TooLargeError(`Handoff is ${data.length} bytes; the limit is ${limits.maxFileBytes}`);
      }

      try {
        // "wx": never overwrite, so handoffs are append-only
        await fs.writeFile(path.join(dir, `${id}.md`), data, { flag: "wx", mode: 0o644 });
        return { id, path: `${HANDOFF_DIR}/${id}.md` };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new ConflictError("Could not allocate a unique handoff id; retry");
  }

  async function list(filter: HandoffFilter = {}) {
    const dir = await handoffDir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isMissing(err)) return { handoffs: [] as HandoffSummary[], skipped: 0 };
      throw err;
    }

    const candidates = names
      .filter((n) => n.endsWith(".md") && HANDOFF_ID.test(n.slice(0, -3)))
      .map((name) => ({ name, stamp: STAMP.exec(name.slice(0, -3))![1]! }))
      .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
      .slice(0, MAX_SCAN);

    const limit = Math.min(filter.limit ?? 20, 50);
    const handoffs: HandoffSummary[] = [];
    let skipped = 0;

    for (const c of candidates) {
      if (handoffs.length >= limit) break;
      try {
        const { meta } = await readMeta(path.join(dir, c.name));
        if (`${meta.id}.md` !== c.name) {
          skipped++;
          continue;
        }
        if (filter.to && meta.to !== filter.to) continue;
        if (filter.from && meta.from !== filter.from) continue;
        if (filter.status && meta.status !== filter.status) continue;
        handoffs.push({
          id: meta.id,
          from: meta.from,
          to: meta.to,
          task: meta.task,
          status: meta.status,
          created: meta.created,
        });
      } catch {
        skipped++; // malformed files are skipped, never fatal
      }
    }
    return { handoffs, skipped };
  }

  async function read(id: string) {
    if (!HANDOFF_ID.test(id)) throw new InvalidContentError("Invalid handoff id");
    const dir = await handoffDir();
    try {
      const r = await readMeta(path.join(dir, `${id}.md`));
      if (r.meta.id !== id) throw new InvalidContentError("Malformed handoff: id mismatch");
      return r;
    } catch (err) {
      if (isMissing(err)) throw new NotFoundError(`Not found: handoff ${id}`);
      throw err;
    }
  }

  return { write, list, read };
}
```

### `src/core/gitRunner.ts` (new)

Safety choices, all in this one file:

- `execFile` with an argument array and no shell.
- Pinned `GIT_DIR` and `GIT_WORK_TREE`. This matters: `workspace/` sits inside your project's own repo, and without pinning, git could quietly operate on the parent repo.
- `GIT_LITERAL_PATHSPECS` so agent-supplied paths can't use pathspec magic like `:(glob)**`.
- A minimal environment, so `AGENT_TOKENS` is never passed to a subprocess.

```ts
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Limits } from "../config.js";
import { ConflictError, GitError } from "./errors.js";
import type { Locks } from "./locks.js";
import type { Sandbox } from "./sandbox.js";

const execFileAsync = promisify(execFile);

const REPO_LOCK = "git:repo";
const MAX_BUFFER = 5 * 1024 * 1024;
const ENV_ALLOWLIST = [
  "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT",
];
const EXCLUDES = [".env", ".env.*", "node_modules/", "*.tmp"];
const STATUS_LABEL: Record<string, string> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "typechange",
};

export type GitRunner = ReturnType<typeof createGitRunner>;

type RunOpts = { okCodes?: number[]; ignoreFailure?: boolean };
type RunResult = { stdout: string; stderr: string; code: number };

export function createGitRunner(deps: { sandbox: Sandbox; locks: Locks; limits: Limits }) {
  const { sandbox, locks, limits } = deps;
  const root = sandbox.root;

  const env: NodeJS.ProcessEnv = (() => {
    const e: NodeJS.ProcessEnv = {};
    const seen = new Set<string>();
    for (const k of ENV_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined && !seen.has(k.toLowerCase())) {
        e[k] = v;
        seen.add(k.toLowerCase());
      }
    }
    return {
      ...e,
      GIT_DIR: path.join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    };
  })();

  const scrub = (s: string) =>
    s.split(root).join("<workspace>").split(root.replace(/\\/g, "/")).join("<workspace>").trim().slice(0, 300);

  async function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
    const full = [
      "-c", "core.quotepath=false",
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "core.fsmonitor=false",
      ...args,
    ];
    try {
      const { stdout, stderr } = await execFileAsync("git", full, {
        cwd: root,
        env,
        timeout: limits.gitTimeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { code?: string | number; killed?: boolean; stdout?: string; stderr?: string };
      if (e.code === "ENOENT") throw new GitError("git is not installed or not on PATH");
      if (e.killed) throw new GitError("git timed out");
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new GitError("git output too large");
      if (typeof e.code === "number") {
        if (opts.ignoreFailure || opts.okCodes?.includes(e.code)) {
          return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
        }
        throw new GitError(scrub(e.stderr || e.stdout || `git exited with code ${e.code}`));
      }
      throw new GitError("git failed to run");
    }
  }

  async function pathspec(rel: string): Promise<string> {
    const abs = await sandbox.resolveSafePath(rel, { allowRoot: true });
    return sandbox.toRelative(abs);
  }

  /** Keep protected files out of commits even if the host operator drops them in the workspace. */
  async function ensureExcludes() {
    const file = path.join(root, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, "utf8").catch(() => "");
    const have = new Set(current.split(/\r?\n/));
    const missing = EXCLUDES.filter((l) => !have.has(l));
    if (missing.length > 0) {
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      await fs.appendFile(file, `${sep}${missing.join("\n")}\n`);
    }
  }

  async function ensureRepo() {
    const exists = await fs.stat(path.join(root, ".git")).then(() => true, () => false);
    if (!exists) {
      await run(["init"]);
      await run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    await ensureExcludes();
    return { created: !exists };
  }

  function parseBranch(s: string): string {
    const unborn = /^No commits yet on (.+)$/.exec(s);
    return unborn ? unborn[1]! : s.split("...")[0]!;
  }

  async function status() {
    const { stdout } = await run(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
    const records = stdout.split("\0").filter(Boolean);
    let branch = "unknown";
    const changed: { path: string; status: string }[] = [];
    let truncated = false;

    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (rec.startsWith("## ")) {
        branch = parseBranch(rec.slice(3));
        continue;
      }
      const xy = rec.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C") i++; // -z puts the old name in the next record
      if (changed.length >= limits.maxListEntries) {
        truncated = true;
        continue;
      }
      const code = xy === "??" ? "untracked" : STATUS_LABEL[xy[0] !== " " ? xy[0]! : xy[1]!] ?? "changed";
      changed.push({ path: rec.slice(3), status: code });
    }
    return { branch, changed, truncated };
  }

  async function diff(rel?: string, staged = false) {
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if (staged) args.push("--cached");
    if (rel) args.push("--", await pathspec(rel));
    const { stdout } = await run(args);
    return stdout.length > limits.maxDiffBytes
      ? { diff: stdout.slice(0, limits.maxDiffBytes), truncated: true }
      : { diff: stdout, truncated: false };
  }

  async function commit(agentId: string, message: string, rels: string[] = []) {
    const msg = message.trim();
    if (!msg || msg.includes("\0")) throw new GitError("Commit message is empty or invalid");

    const specs: string[] = [];
    for (const r of rels) specs.push(await pathspec(r));
    const scope = specs.length > 0 ? ["--", ...specs] : [];
    const ident = [
      "-c", `user.name=${agentId}`,
      "-c", `user.email=${agentId}@workspace.local`,
      "-c", "commit.gpgsign=false",
    ];

    // one writer at a time; the index is rebuilt per commit so agents never commit each other's staged files
    return locks.withLock(REPO_LOCK, async () => {
      await run(["reset", "-q"], { ignoreFailure: true });
      await run(["add", "-A", ...scope]);

      const staged = await run(["diff", "--cached", "--name-only", "-z"]);
      const files = staged.stdout.split("\0").filter(Boolean);
      if (files.length === 0) throw new ConflictError("Nothing to commit");

      await run([
        ...ident, "commit", "--no-verify", "-m", msg,
        "--author", `${agentId} <${agentId}@workspace.local>`,
      ]);
      const head = await run(["rev-parse", "--short", "HEAD"]);
      return { commit: head.stdout.trim(), author: agentId, files_changed: files.length, files: files.slice(0, 50) };
    });
  }

  async function log(limit = 20, rel?: string) {
    const args = ["log", "--no-color", `-n${Math.min(limit, 50)}`, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e"];
    if (rel) args.push("--", await pathspec(rel));
    const res = await run(args, { okCodes: [128] });

    if (res.code === 128) {
      if (/does not have any commits yet/i.test(res.stderr)) return { commits: [] };
      throw new GitError(scrub(res.stderr || "git log failed"));
    }
    const commits = res.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash = "", author = "", date = "", subject = ""] = rec.split("\x1f");
        return { hash: hash.slice(0, 12), author, date, subject };
      });
    return { commits };
  }

  return { ensureRepo, status, diff, commit, log };
}
```

### `src/core/services.ts` (replace)

Keep your existing `createFsOps(...)` call style. I use the positional form from the file you pasted. Only the lines for `handoff`, `git` and `audit` are new.

```ts
import type { Config } from "../config.js";
import { createAudit } from "./audit.js";
import { createFsOps } from "./fsOps.js";
import { createGitRunner } from "./gitRunner.js";
import { createHandoffStore } from "./handoffStore.js";
import { createLocks } from "./locks.js";
import { createSandbox } from "./sandbox.js";

export type Services = ReturnType<typeof createServices>;

export function createServices(cfg: Config) {
  const sandbox = createSandbox(cfg.workspaceRoot);
  const locks = createLocks(cfg.limits.lockTimeoutMs);
  const fs = createFsOps(sandbox, locks, cfg.limits);
  const handoff = createHandoffStore({
    sandbox,
    limits: cfg.limits,
    knownAgents: new Set(cfg.agentTokens.values()),
  });
  const git = createGitRunner({ sandbox, locks, limits: cfg.limits });
  const audit = createAudit(cfg.auditPath);
  return { fs, handoff, git, audit };
}
```

---

## 3. Tools layer

### `src/tools/result.ts` (replace)

The only change is that `fail` now tags the error class, so the audit log can record `SandboxError` and similar.

```ts
import { AppError } from "../core/errors.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  if (err instanceof AppError) {
    return {
      isError: true,
      content: [{ type: "text", text: err.message }],
      _meta: { errorType: err.name },
    };
  }
  console.error("[internal error]", err);
  return {
    isError: true,
    content: [{ type: "text", text: "Internal error" }],
    _meta: { errorType: "InternalError" },
  };
}
```

### `src/tools/instrument.ts` (new)

One wrapper audits every tool, present and future, so no handler can forget to log. Only whitelisted argument names are logged, so file contents, hashes, edit strings and commit messages never reach the log.

```ts
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
```

### `src/tools/handoff.ts` (new)

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HANDOFF_ID, HANDOFF_STATUSES } from "../core/handoffStore.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";
import { agentId as agentIdSchema, relPath } from "./schemas.js";

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
```

### `src/tools/git.ts` (new)

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";
import { relPath } from "./schemas.js";

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
```

### `src/tools/index.ts` (replace)

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerFileTools } from "./files.js";
import { registerGitTools } from "./git.js";
import { registerHandoffTools } from "./handoff.js";
import { withAudit } from "./instrument.js";

export function registerAllTools(server: McpServer, ctx: ToolContext) {
  withAudit(server, ctx); // must run first so every tool below is audited
  registerFileTools(server, ctx);
  registerHandoffTools(server, ctx);
  registerGitTools(server, ctx);
}
```

### `src/index.ts` (replace)

```ts
import { loadConfig } from "./config.js";
import { createServices } from "./core/services.js";
import { createApp } from "./transport/app.js";
import { createAuthenticator } from "./transport/auth.js";

const config = loadConfig();
const services = createServices(config);

try {
  const repo = await services.git.ensureRepo();
  console.log(repo.created ? "[git] initialised workspace repo" : "[git] workspace repo ready");
} catch (err) {
  // the file tools still work; git tools will report the problem
  console.warn("[git] unavailable:", (err as Error).message);
}

const app = createApp(services, createAuthenticator(config.agentTokens));

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`mcp-workspace listening on http://127.0.0.1:${config.port}/mcp`);
  console.log(`workspace root: ${config.workspaceRoot}`);
  console.log(`agents configured: ${[...config.agentTokens.values()].join(", ")}`);
  console.log(`audit log: ${services.audit.path}`);
});

// pm2 sends SIGINT on restart: finish writing the audit log first
const shutdown = async () => {
  server.close();
  await services.audit.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

---

## 4. Tests

### `test/helpers.ts` (change, don't replace)

Keep everything you have, including `canSymlink` if you added it. Then:

**a) Add these imports at the top:**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/transport/createServer.js";
```

**b) In `makeWorkspace`**, add the audit path to the config call, to the return object, and flush before cleanup:

```ts
const auditPath = path.join(base, "audit.jsonl");

const config = loadConfig({
  WORKSPACE_ROOT: root,
  AUDIT_PATH: auditPath,
  AGENT_TOKENS: `${TOKEN_A}:agent-a,${TOKEN_B}:agent-b`,
  ...overrides,
} as NodeJS.ProcessEnv);

// in the returned object:
auditPath,
cleanup: async () => {
  await services.audit.flush();
  await fs.rm(base, { recursive: true, force: true });
},
```

**c) Append these helpers:**

```ts
export async function connectAgent(ws: TestWorkspace, agentId: string) {
  const server = createServer({ agentId, services: ws.services });
  const client = new Client({ name: `test-${agentId}`, version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    return { isError: Boolean(r.isError), text };
  } catch (err) {
    return { isError: true, text: String(err) };
  }
}

export async function readAudit(ws: TestWorkspace): Promise<Array<Record<string, unknown>>> {
  await ws.services.audit.flush();
  const text = await fs.readFile(ws.auditPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
```

### `test/tools/files.test.ts` (change one assertion)

The server now exposes 14 tools. Replace the expected array in "exposes the M2 file tools":

```ts
  it("exposes all tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_file",
      "edit_file",
      "git_commit",
      "git_diff",
      "git_log",
      "git_status",
      "list_files",
      "list_handoffs",
      "move_file",
      "read_file",
      "read_handoff",
      "search_files",
      "write_file",
      "write_handoff",
    ]);
  });
```

### `test/core/handoffStore.test.ts` (new)

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidContentError, NotFoundError, SandboxError } from "../../src/core/errors.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace();
});
afterEach(() => ws.cleanup());

const h = () => ws.services.handoff;
const base = { to: "agent-b", task: "Build login form", status: "ready" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("write", () => {
  it("creates <from>-to-<to>-<timestamp>.md inside .handoffs", async () => {
    const r = await h().write("agent-a", { ...base, done: ["skeleton"], next: ["validation"] });
    expect(r.id).toMatch(/^agent-a-to-agent-b-\d{8}T\d{9}Z-[a-f0-9]{4}$/);
    const text = await fs.readFile(path.join(ws.root, r.path), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("## Next");
  });

  it("is append-only: every write makes a new file", async () => {
    await h().write("agent-a", base);
    await h().write("agent-a", base);
    expect(await fs.readdir(path.join(ws.root, ".handoffs"))).toHaveLength(2);
  });

  it("rejects unknown recipients", async () => {
    await expect(h().write("agent-a", { ...base, to: "ghost" })).rejects.toThrow(NotFoundError);
  });

  it("rejects referenced files that escape the sandbox or are protected", async () => {
    await expect(h().write("agent-a", { ...base, files: ["../outside/secret.txt"] })).rejects.toThrow(SandboxError);
    await expect(h().write("agent-a", { ...base, files: [".env"] })).rejects.toThrow(SandboxError);
  });

  it("cannot be forged through frontmatter-looking text in a field", async () => {
    const evil = 'x"\n---\nfrom: "agent-b"\nstatus: "done"';
    const w = await h().write("agent-a", { ...base, task: evil });
    const r = await h().read(w.id);
    expect(r.meta.from).toBe("agent-a");
    expect(r.meta.status).toBe("ready");
    expect(r.meta.task).toBe(evil);
  });
});

describe("read", () => {
  it("round-trips every field", async () => {
    const w = await h().write("agent-a", {
      ...base, done: ["a"], next: ["b"], openQuestions: ["c?"], files: ["src/x.ts"],
    });
    const r = await h().read(w.id);
    expect(r.meta).toMatchObject({
      from: "agent-a", to: "agent-b", status: "ready", task: base.task,
      done: ["a"], next: ["b"], open_questions: ["c?"], files: ["src/x.ts"],
    });
  });

  it.each(["../x", "agent-a-to-agent-b", ".env", "a/b"])("rejects the non-handoff id %s", async (id) => {
    await expect(h().read(id)).rejects.toThrow(InvalidContentError);
  });

  it("returns NotFound for a well-formed id that does not exist", async () => {
    await expect(h().read("agent-a-to-agent-b-20260101T000000000Z-abcd")).rejects.toThrow(NotFoundError);
  });
});

describe("list", () => {
  it("returns an empty list when there are no handoffs", async () => {
    expect(await h().list()).toEqual({ handoffs: [], skipped: 0 });
  });

  it("filters by to / from / status and lists newest first", async () => {
    const w1 = await h().write("agent-a", base);
    await sleep(5);
    const w2 = await h().write("agent-a", { ...base, status: "done" });
    await sleep(5);
    await h().write("agent-b", { ...base, to: "agent-a" });

    const inbox = await h().list({ to: "agent-b" });
    expect(inbox.handoffs.map((x) => x.id)).toEqual([w2.id, w1.id]);
    expect((await h().list({ status: "done" })).handoffs).toHaveLength(1);
    expect((await h().list({ from: "agent-b" })).handoffs).toHaveLength(1);
  });

  it("skips malformed handoff files and counts them", async () => {
    await fs.mkdir(path.join(ws.root, ".handoffs"));
    await fs.writeFile(
      path.join(ws.root, ".handoffs", "agent-a-to-agent-b-20261007T143012123Z-abcd.md"),
      "garbage",
    );
    expect(await h().list()).toEqual({ handoffs: [], skipped: 1 });
  });
});
```

### `test/core/gitRunner.test.ts` (new)

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, SandboxError } from "../../src/core/errors.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let ws: TestWorkspace;
const git = () => ws.services.git;

describe.skipIf(!hasGit)("git-lite", () => {
  beforeEach(async () => {
    ws = await makeWorkspace();
    await git().ensureRepo();
  });
  afterEach(() => ws.cleanup());

  it("creates the repo inside the workspace, not the parent", async () => {
    await expect(fs.stat(path.join(ws.root, ".git"))).resolves.toBeTruthy();
  });

  it("keeps protected files out of status", async () => {
    await fs.writeFile(path.join(ws.root, ".env"), "SECRET=1");
    await ws.services.fs.write("notes.txt", "hi");
    const s = await git().status();
    expect(s.branch).toBe("main");
    expect(s.changed).toEqual([{ path: "notes.txt", status: "untracked" }]);
  });

  it("returns an empty log before the first commit", async () => {
    expect(await git().log()).toEqual({ commits: [] });
  });

  it("commits as the calling agent", async () => {
    await ws.services.fs.write("a.txt", "hi");
    const c = await git().commit("agent-a", "add a");
    expect(c).toMatchObject({ author: "agent-a", files_changed: 1 });
    const { commits } = await git().log();
    expect(commits[0]).toMatchObject({ author: "agent-a", subject: "add a" });
  });

  it("attributes each commit to its own agent", async () => {
    await ws.services.fs.write("a.txt", "1");
    await git().commit("agent-a", "from a");
    await ws.services.fs.write("b.txt", "2");
    await git().commit("agent-b", "from b");
    const { commits } = await git().log();
    expect(commits.map((c) => c.author)).toEqual(["agent-b", "agent-a"]);
  });

  it("refuses an empty commit", async () => {
    await expect(git().commit("agent-a", "nothing")).rejects.toThrow(ConflictError);
  });

  it("commits only the requested paths", async () => {
    await ws.services.fs.write("a.txt", "1");
    await ws.services.fs.write("b.txt", "2");
    const c = await git().commit("agent-a", "only a", ["a.txt"]);
    expect(c.files).toEqual(["a.txt"]);
    expect((await git().status()).changed).toEqual([{ path: "b.txt", status: "untracked" }]);
  });

  it("shows changes to tracked files in diff", async () => {
    const w = await ws.services.fs.write("a.txt", "hi");
    await git().commit("agent-a", "add a");
    await ws.services.fs.edit("a.txt", "hi", "hello", w.sha256);
    const d = await git().diff("a.txt");
    expect(d.diff).toContain("-hi");
    expect(d.diff).toContain("+hello");
  });

  it("rejects paths that escape the sandbox or are protected", async () => {
    await expect(git().diff("../outside/secret.txt")).rejects.toThrow(SandboxError);
    await expect(git().diff(".git/config")).rejects.toThrow(SandboxError);
    await expect(git().commit("agent-a", "x", ["../x"])).rejects.toThrow(SandboxError);
    await expect(git().log(5, "/etc/passwd")).rejects.toThrow(SandboxError);
  });
});
```

### `test/core/audit.test.ts` (new)

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAudit } from "../../src/core/audit.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("audit", () => {
  it("appends one JSON line per record, in order, creating missing folders", async () => {
    const file = path.join(dir, "nested", "audit.jsonl");
    const audit = createAudit(file);
    audit.record({ agent: "agent-a", tool: "read_file", ok: true, ms: 1, args: { path: "a.txt" } });
    audit.record({ agent: "agent-b", tool: "read_file", ok: false, ms: 2, error: "SandboxError", args: { path: "../x" } });
    await audit.flush();

    const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ agent: "agent-a", tool: "read_file", ok: true, path: "a.txt" });
    expect(lines[1]).toMatchObject({ agent: "agent-b", ok: false, error: "SandboxError", path: "../x" });
    expect(typeof lines[0].ts).toBe("string");
  });
});
```

### `test/tools/protocol.test.ts` (new)

```ts
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, connectAgent, makeWorkspace, readAudit, type TestWorkspace } from "../helpers.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let ws: TestWorkspace;
let a: Awaited<ReturnType<typeof connectAgent>>;
let b: Awaited<ReturnType<typeof connectAgent>>;

beforeEach(async () => {
  ws = await makeWorkspace();
  a = await connectAgent(ws, "agent-a");
  b = await connectAgent(ws, "agent-b");
});
afterEach(async () => {
  await a.close();
  await b.close();
  await ws.cleanup();
});

describe("handoff between two agents", () => {
  it("A writes, B finds it in its inbox and reads it", async () => {
    const w = await callTool(a.client, "write_handoff", {
      to: "agent-b",
      task: "Add validation",
      status: "ready",
      next: ["write tests"],
    });
    expect(w.isError).toBe(false);
    const { id } = JSON.parse(w.text);

    const inbox = JSON.parse((await callTool(b.client, "list_handoffs", { to: "agent-b" })).text);
    expect(inbox.handoffs).toHaveLength(1);
    expect(inbox.handoffs[0]).toMatchObject({ id, from: "agent-a", status: "ready" });

    const r = JSON.parse((await callTool(b.client, "read_handoff", { id })).text);
    expect(r.meta.next).toEqual(["write tests"]);
  });

  it("the sender is always the authenticated agent", async () => {
    const w = await callTool(b.client, "write_handoff", { to: "agent-a", task: "Review", status: "done" });
    const { id } = JSON.parse(w.text);
    const r = JSON.parse((await callTool(a.client, "read_handoff", { id })).text);
    expect(r.meta.from).toBe("agent-b");
  });

  it("file tools cannot write, move or delete inside .handoffs", async () => {
    const w = await callTool(a.client, "write_handoff", { to: "agent-b", task: "T", status: "ready" });
    const { id } = JSON.parse(w.text);

    expect((await callTool(a.client, "write_file", { path: ".handoffs/fake.md", content: "x" })).isError).toBe(true);
    await callTool(a.client, "write_file", { path: "n.txt", content: "x" });
    expect((await callTool(a.client, "move_file", { from: "n.txt", to: ".handoffs/n.md" })).isError).toBe(true);
    expect((await callTool(a.client, "move_file", { from: `.handoffs/${id}.md`, to: "stolen.md" })).isError).toBe(true);
    expect((await callTool(a.client, "read_handoff", { id })).isError).toBe(false);
  });

  it("rejects unknown recipients and bad ids", async () => {
    expect((await callTool(a.client, "write_handoff", { to: "ghost", task: "T", status: "ready" })).isError).toBe(true);
    expect((await callTool(a.client, "read_handoff", { id: "../../etc/passwd" })).isError).toBe(true);
  });
});

describe("audit log", () => {
  it("records blocked attempts with agent, tool and error type", async () => {
    await callTool(b.client, "read_file", { path: "../outside/secret.txt" });
    const entries = await readAudit(ws);
    expect(entries).toContainEqual(
      expect.objectContaining({
        agent: "agent-b",
        tool: "read_file",
        ok: false,
        error: "SandboxError",
        path: "../outside/secret.txt",
      }),
    );
  });

  it("records successes and never logs file contents", async () => {
    await callTool(a.client, "write_file", { path: "n.txt", content: "SUPERSECRET-CONTENT" });
    const entries = await readAudit(ws);
    expect(entries).toContainEqual(
      expect.objectContaining({ agent: "agent-a", tool: "write_file", ok: true, path: "n.txt" }),
    );
    expect(JSON.stringify(entries)).not.toContain("SUPERSECRET-CONTENT");
  });
});

describe.skipIf(!hasGit)("git over MCP", () => {
  it("commits are attributed to the calling agent", async () => {
    await ws.services.git.ensureRepo();

    await callTool(a.client, "write_file", { path: "x.txt", content: "1" });
    expect((await callTool(a.client, "git_commit", { message: "add x" })).isError).toBe(false);

    await callTool(b.client, "write_file", { path: "y.txt", content: "2" });
    await callTool(b.client, "git_commit", { message: "add y" });

    const log = JSON.parse((await callTool(a.client, "git_log", {})).text);
    expect(log.commits.map((c: { author: string }) => c.author)).toEqual(["agent-b", "agent-a"]);

    const status = JSON.parse((await callTool(a.client, "git_status", {})).text);
    expect(status.changed).toEqual([]);
  });

  it("refuses an empty commit and a protected path", async () => {
    await ws.services.git.ensureRepo();
    expect((await callTool(a.client, "git_commit", { message: "nothing" })).isError).toBe(true);
    expect((await callTool(a.client, "git_diff", { path: ".git/config" })).isError).toBe(true);
  });
});
```

---

## 5. Run it

```powershell
npm run typecheck
npm run deps
npm test
```

If `typecheck` complains about `createFsOps` arguments in `services.ts`, switch that line to whichever form your `fsOps.ts` uses.

Then run the real server:

```powershell
npm run dev
```

You should see `[git] initialised workspace repo` the first time. Check that `workspace\.git` exists and that the **project's** own `git status` is unchanged. `workspace/` is gitignored there, so the parent repo shouldn't notice.

### Manual checks in Inspector (two windows, one per token)

| Step | Window | Call | Expected |
|---|---|---|---|
| 1 | A | `write_file` `{path:"hello.txt", content:"hi"}` | created |
| 2 | A | `write_handoff` `{to:"agent-b", task:"Review hello.txt", status:"ready", files:["hello.txt"]}` | returns an id |
| 3 | B | `list_handoffs` `{to:"agent-b"}` | shows the handoff from `agent-a` |
| 4 | B | `read_handoff` `{id:"<id from step 2>"}` | full content |
| 5 | B | `git_commit` `{message:"add hello"}` | `author: "agent-b"` |
| 6 | A | `write_file` to `.handoffs/x.md` | refused |
| 7 | B | `read_file` `{path:"../README.md"}` | refused |
| 8 | A | `write_file` over `hello.txt` twice with the same old hash | second one conflicts |

In PowerShell, check the evidence for M5:

```powershell
Get-Content logs\audit.jsonl -Tail 15
git -C workspace log --pretty=format:"%an | %s"
```

Step 7 should appear in the audit log as `ok:false`, `error:"SandboxError"`. The `git log` line should show `agent-b | add hello`.

After code changes, rebuild before pm2 picks them up:

```powershell
npm run build
pm2 restart mcp-server
```

## M4 is done when

- `npm test` and `npm run deps` are clean.
- A stale-hash write and an oversized write are both rejected. The M2 tests plus the `files.test.ts` conflict test already cover this.
- A handoff goes A to B and B reads it. The file sits in `workspace/.handoffs/`.
- Commits show the right agent as author.
- The audit log has a line for every call, including blocked ones, and no file contents.

## Differences from `design.md` to update

- **Handoff id:** it has an extra 4-hex random suffix (`...-20261007T143012123Z-a1b2`), so two handoffs in the same millisecond can't collide.
- **Frontmatter:** each value is JSON on one line (`status: "ready"`) instead of loose YAML, so text in a field can't fake another field.
- **Audit entries:** `path`, `from`, `to`, `id` and similar are top-level keys. There are no `bytes` or `sha256` fields yet.

## Limits worth stating in the report

- **Audit gaps:** requests that fail zod validation are rejected by the SDK before the handler runs, so they don't reach the audit log. Failed auth attempts are only in the pm2 console log.
- **Git locking:** the git lock covers only git operations. A `write_file` can still land between `git add` and `git commit`. In that case the file simply isn't in that commit.
- **`git_diff`:** it shows tracked-file changes only. New files appear in `git_status`.

Once this passes, tell me and we'll go to M5: the multi-agent run, the evidence collection and the report outline.