# Design

**Project:** Shared-workspace MCP server (Part E, Project 17)
**Status:** Draft
**Companion doc:** `architecture.md` (structure and dependency rules)
**Last updated:** 2026-10-07

This document specifies behavior: tool contracts, the sandbox algorithm, guards, handoff format, auth, errors, and the test plan.

---

## 1. Configuration

Parsed with zod in `config.ts`, then frozen.

| Variable           | Example                       | Purpose                                      |
| ------------------ | ----------------------------- | -------------------------------------------- |
| `PORT`             | `3000`                        | Local listen port                            |
| `WORKSPACE_ROOT`   | `./workspace`                 | Sandbox root (absolute path after resolve)   |
| `AUDIT_PATH`       | `./logs/audit.jsonl`          | Audit log file                               |
| `AGENT_TOKENS`     | `tok_a:agent-a,tok_b:agent-b` | Token to agentId map                         |
| `MAX_FILE_BYTES`   | `262144`                      | Max size of one written file (256 KB)        |
| `MAX_READ_BYTES`   | `524288`                      | Max bytes returned by `read_file`            |
| `MAX_LIST_ENTRIES` | `500`                         | Cap on `list_files` / `search_files` results |
| `LOCK_TIMEOUT_MS`  | `3000`                        | Max wait for a per-file lock                 |

Startup fails fast if `WORKSPACE_ROOT` does not exist or `AGENT_TOKENS` is empty.

---

## 2. Sandbox design (`core/sandbox.ts`)

The sandbox is the single choke point for every path.

### 2.1 `resolveSafePath(rel, opts)`

```
input:  rel (string from the agent), opts { mustExist: boolean }
output: absolute path inside the workspace, or throws SandboxError
```

Steps, in order:

1. Reject if `rel` is not a string, is empty, or is longer than 512 chars.
2. Reject if it contains a null byte (`\0`).
3. Reject if it is absolute (starts with `/`, `\`, or a drive letter like `C:`).
4. Normalize separators, then `candidate = path.resolve(root, rel)`.
5. Reject if `candidate` is not `root` or does not start with `root + path.sep`.
6. Check the **deny-list** against the relative segments (see 2.2).
7. Resolve symlinks:
   - If the target exists: `real = fs.realpath(candidate)`.
   - If it does not exist (new file): `real = fs.realpath(parent) + basename`. The parent must exist and pass the same containment check.
8. Re-check containment on `real` (this is what defeats symlinks pointing outside).
9. If `mustExist` is true and the target is missing, throw `NotFoundError`.
10. Return `real`.

The root itself is `realpath`-ed once at startup so comparisons are consistent.

### 2.2 Deny-list

| Pattern                               | Reason                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| any segment equal to `.git`           | Prevent tampering with history; git tools are the only way in |
| `.env`, `.env.*`                      | Secrets                                                       |
| `node_modules`                        | Noise and size                                                |
| segment equal to `..` after normalize | Defense in depth                                              |

`.handoffs/` is **allowed** for handoff tools, and **read-only** for generic file write tools (see 3.2).

### 2.3 Known weak spot

There is a time gap between checking a path and using it (TOCTOU). Mitigation: operations run under the per-file lock, and `fsOps` opens files with `O_NOFOLLOW` where the platform allows. Document any remaining gap honestly in the report.

---

## 3. Tool contracts

All inputs use zod. All paths are **relative to the workspace root**. Every successful or failed call writes one audit record.

Shared schema pieces (`tools/schemas.ts`):

```ts
const relPath = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const agentId = z.string().regex(/^[a-z0-9-]{1,32}$/);
```

### 3.1 Read-only file tools

| Tool           | Input                                                               | Output                                                                 |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `list_files`   | `{ path?: relPath = ".", recursive?: boolean = false }`             | `{ entries: [{ path, type: "file"\|"dir", size, mtime }], truncated }` |
| `read_file`    | `{ path: relPath, offset?: int, length?: int }`                     | `{ content, sha256, size, truncated }`                                 |
| `search_files` | `{ query: string(1..200), path?: relPath, max_results?: int<=100 }` | `{ matches: [{ path, line, text }], truncated }`                       |

Notes:

- `read_file` always returns the `sha256` of the **full** file, so the agent can pass it back on write.
- Binary files are refused (see 4.2).

### 3.2 Write tools

| Tool          | Input                                                                | Output                              |
| ------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `write_file`  | `{ path, content, expected_sha256?: sha256, create_only?: boolean }` | `{ path, sha256, size, created }`   |
| `edit_file`   | `{ path, old_string, new_string, expected_sha256?: sha256 }`         | `{ path, sha256, replacements: 1 }` |
| `move_file`   | `{ from: relPath, to: relPath }`                                     | `{ from, to }`                      |
| `delete_file` | `{ path, expected_sha256: sha256 }`                                  | `{ path, deleted: true }`           |

Behavior:

- `write_file` on an **existing** file requires `expected_sha256`, otherwise `ConflictError("expected_sha256 required to overwrite")`. For a new file, omit it or set `create_only: true`.
- `edit_file` requires `old_string` to match **exactly once**; zero or many matches is an error.
- `delete_file` requires the hash so an agent cannot delete a file it has never read.
- Generic write tools cannot write inside `.handoffs/` (use handoff tools).

### 3.3 Handoff tools

| Tool            | Input                                                                                                                                             | Output                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `write_handoff` | `{ to: agentId, task: string, status: "ready"\|"blocked"\|"done", done: string[], next: string[], open_questions?: string[], files?: relPath[] }` | `{ id, path }`                                            |
| `list_handoffs` | `{ to?: agentId, from?: agentId, status?: enum, limit?: int<=50 }`                                                                                | `{ handoffs: [{ id, from, to, task, status, created }] }` |
| `read_handoff`  | `{ id: string }`                                                                                                                                  | `{ meta, body }`                                          |

`from` is **always** set from the authenticated `agentId`, never from input. An agent cannot forge a handoff from someone else.

### 3.4 Git-lite tools

| Tool         | Input                                            | Output                                           |
| ------------ | ------------------------------------------------ | ------------------------------------------------ |
| `git_status` | `{}`                                             | `{ branch, changed: [{ path, status }] }`        |
| `git_diff`   | `{ path?: relPath, staged?: boolean }`           | `{ diff, truncated }`                            |
| `git_commit` | `{ message: string(1..200), paths?: relPath[] }` | `{ commit, files_changed }`                      |
| `git_log`    | `{ limit?: int<=50, path?: relPath }`            | `{ commits: [{ hash, author, date, message }] }` |

Rules:

- Run with `execFile("git", args, { cwd: root, timeout: 5000 })`. Never a shell.
- `message` is passed as an argument, never interpolated into a string.
- Commit author: `--author "<agentId> <agentId@workspace.local>"`.
- No push, pull, checkout, reset, branch, or config tools. Git-lite is intentionally small.
- `paths` go through `resolveSafePath` first, then are passed after `--`.

---

## 4. Guards (`core/guards.ts`, `core/locks.ts`)

### 4.1 Optimistic concurrency

```
agent A: read_file  -> content + sha256 = H1
agent B: read_file  -> content + sha256 = H1
agent B: write_file(expected_sha256 = H1) -> ok, file is now H2
agent A: write_file(expected_sha256 = H1) -> ConflictError (current is H2)
```

The `ConflictError` message includes the current hash so the agent can re-read and retry.

### 4.2 Content rules

| Rule                            | Value                      | On violation                       |
| ------------------------------- | -------------------------- | ---------------------------------- |
| Max write size                  | `MAX_FILE_BYTES`           | `TooLargeError`                    |
| Text only                       | valid UTF-8, no null bytes | `InvalidContentError`              |
| Max path depth                  | 12 segments                | `SandboxError`                     |
| Max files per directory listing | `MAX_LIST_ENTRIES`         | truncate and set `truncated: true` |

### 4.3 Per-file lock

- In-memory map from absolute path to a promise chain.
- Acquire before the hash check, release after the write completes.
- Wait up to `LOCK_TIMEOUT_MS`, then throw `LockTimeoutError`.
- `move_file` locks both paths in sorted order to avoid deadlock.
- Because the server is a single process, in-memory locks are enough. If it ever runs as multiple pm2 instances, this needs replacing.

---

## 5. Handoff file format (`core/handoffStore.ts`)

**Location:** `workspace/.handoffs/`
**Name:** `<from>-to-<to>-<UTC timestamp>.md`, for example `agent-a-to-agent-b-20261007T143012Z.md`

```markdown
---
id: agent-a-to-agent-b-20261007T143012Z
from: agent-a
to: agent-b
status: ready # ready | blocked | done
task: Implement the login form validation
created: 2026-10-07T14:30:12Z
files:
  - src/login.ts
---

## Done

- Created form skeleton in src/login.ts

## Next

- Add email and password validation
- Write tests

## Open questions

- Should the password minimum be 8 or 12?
```

Rules:

- IDs are generated by the server, never accepted from the agent.
- Handoff files are **append-only**: `write_handoff` always creates a new file. Status changes are made by writing a follow-up handoff, not editing an old one.
- Frontmatter is parsed with a strict schema. A malformed handoff is skipped in listings and reported in the audit log.

---

## 6. Authentication (`transport/auth.ts`)

- Header: `Authorization: Bearer <token>`.
- Tokens come from `AGENT_TOKENS`, compared with `crypto.timingSafeEqual`.
- Success sets `agentId` on the request, which is copied into `ToolContext`.
- Failure returns `401` with no detail about whether the token existed.
- The ngrok interstitial can break non-browser clients, so test early with a real client in M3.

---

## 7. Error model (`core/errors.ts`)

| Error                 | Meaning                              | Agent-facing message style                                   |
| --------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `SandboxError`        | Path escape, deny-listed, bad path   | "Path not allowed: <reason>" (never reveals real host paths) |
| `NotFoundError`       | Target missing                       | "Not found: <relative path>"                                 |
| `ConflictError`       | Hash mismatch, exists on create_only | Includes current hash                                        |
| `TooLargeError`       | Over size cap                        | Includes the limit                                           |
| `InvalidContentError` | Binary or non-UTF-8                  | States what was wrong                                        |
| `LockTimeoutError`    | Lock wait exceeded                   | "File busy, retry"                                           |
| `GitError`            | Git exit code non-zero               | Trimmed stderr, no host paths                                |

Mapping: tool handlers catch these and return `{ isError: true, content: [{ type: "text", text }] }`. Anything unexpected is logged in full to the audit log and returned as a generic "Internal error".

---

## 8. Audit log (`core/audit.ts`)

JSON Lines, one record per tool call, appended with `fs.appendFile`.

```json
{"ts":"2026-10-07T14:30:12.411Z","agent":"agent-a","tool":"write_file","path":"src/login.ts","ok":true,"bytes":1204,"sha256":"9f2c...","ms":8}
{"ts":"2026-10-07T14:31:40.002Z","agent":"agent-b","tool":"read_file","path":"../../etc/passwd","ok":false,"error":"SandboxError"}
```

Rules:

- Never log file contents or tokens.
- Log blocked attempts too: they are evidence for the M5 report.
- Failure to write the audit log must not crash the server, but should print to stderr.

---

## 9. Test plan

### 9.1 Unit tests (`test/core/`)

**sandbox.test.ts**

| Case                                                  | Expected                             |
| ----------------------------------------------------- | ------------------------------------ |
| `../../etc/passwd`                                    | SandboxError                         |
| `/etc/passwd`, `C:\Windows\x`                         | SandboxError                         |
| `foo/../../x`                                         | SandboxError                         |
| `a\0b`                                                | SandboxError                         |
| `%2e%2e/x` (encoded dots)                             | Treated literally, stays inside root |
| Symlink inside workspace pointing outside             | SandboxError                         |
| New file under a symlinked parent that points outside | SandboxError                         |
| `.git/config`, `.env`                                 | SandboxError                         |
| `./a/./b.txt`, `a//b.txt`                             | Resolves inside root                 |
| Path equal to root (`.`)                              | Allowed for listing only             |

**guards.test.ts**: stale hash rejected, missing hash on overwrite rejected, oversize rejected, binary rejected, create_only on existing file rejected.

**locks.test.ts**: two concurrent writes serialize, timeout fires, `move_file` lock ordering does not deadlock.

**handoffStore.test.ts**: round-trip frontmatter, malformed file skipped, `from` cannot be forged.

### 9.2 Tool tests (`test/tools/`)

Call tool handlers with a `ToolContext` pointing at a temp workspace. Check outputs, error mapping, and that an audit record is written for each call.

### 9.3 End-to-end (`test/e2e/http.test.ts`)

- No token returns 401.
- Wrong token returns 401.
- Valid token and `list_files` returns the workspace listing.
- Two different tokens produce commits with different authors.

### 9.4 Manual (MCP Inspector, then a real client)

- M1: Inspector lists `list_files` and returns results.
- M3: a real client connects through ngrok, then `pm2 restart` and reconnect.

---

## 10. Definition of done per milestone

| Milestone   | Done when                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M1 Skeleton | Inspector connects and `list_files` returns the workspace contents                                                           |
| M2 Sandbox  | All sandbox tests pass, every tool input has a zod schema, all file tools work                                               |
| M3 Deploy   | Server survives `pm2 restart` and reboot, auth enforced, a real client calls a tool through ngrok                            |
| M4 Protocol | Stale-hash and oversize writes rejected, handoffs work between two agents, commits show the right author, audit log complete |
| M5 Prove it | Multi-agent run recorded, blocked attack and caught conflict documented, report written, demo rehearsed                      |

---

## 11. Open questions

- Does the brief require specific tool names? If so, rename in section 3 before M1.
- Is stdio needed for any local testing path, or is Streamable HTTP only enough?
- Should `delete_file` be allowed at all, or replaced by a move to `.trash/` for safer recovery?
- What is the expected agent count for the demo (affects token setup and lock testing)?
