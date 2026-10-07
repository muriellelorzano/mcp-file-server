# Architecture

**Project:** Shared-workspace MCP server (Part E, Project 17)
**Status:** Proposed
**Last updated:** 2026-10-07

> Assumption: the project is an MCP server that lets several AI agents read, write and hand off work through sandboxed file tools, with git-lite tools for history. Update this file if the brief says otherwise.

---

## 1. Goals and non-goals

**Goals**

- Expose a sandboxed workspace to multiple agents over Streamable HTTP.
- Make path escape and bad writes structurally hard, not just tested.
- Let agents coordinate through handoff files and a git history.
- Be deployable on one host (ngrok + pm2) and survive restarts.

**Non-goals**

- Multi-tenant isolation beyond one bearer token per agent.
- A database, a web UI, or horizontal scaling.
- Arbitrary command execution. The only subprocess is `git`.

---

## 2. Tech stack

| Layer           | Choice                                    | Why                                           |
| --------------- | ----------------------------------------- | --------------------------------------------- |
| Runtime and SDK | Node.js + official TypeScript MCP SDK     | Reference choice, best SDK support            |
| Transport       | Streamable HTTP                           | Works with remote clients through a tunnel    |
| Validation      | zod on every tool input                   | Rejects malformed input before any logic runs |
| Exposure        | ngrok with a static domain                | Stable URL for client config                  |
| Process manager | pm2                                       | Restart on crash, start on boot               |
| Version control | git on the host                           | Workspace history, per-agent authorship       |
| Testing         | Vitest, MCP Inspector, then a real client | Unit tests for core, manual for protocol      |

---

## 3. System overview

```
 Agent A (Claude)   Agent B (other client)   MCP Inspector
        |                   |                     |
        +------- HTTPS + Bearer token ------------+
                            |
                  ngrok (static domain)
                            |  localhost:3000
 +--------------------------v---------------------------+
 | pm2 process: Node.js + TypeScript MCP SDK            |
 |                                                      |
 |  Express  POST /mcp  (Streamable HTTP, stateless)    |
 |     |                                                |
 |  Auth middleware: token -> agentId                   |
 |     |                                                |
 |  Tool layer (zod schema on every input)              |
 |   |- file tools                                      |
 |   |- handoff tools                                   |
 |   '- git-lite tools                                  |
 |     |                                                |
 |  Core: sandbox | guards | locks | git | audit        |
 +--------------------------+---------------------------+
                            |
              workspace/  (own git repo, only writable area)
                |- project files
                '- .handoffs/
```

---

## 4. Layers

The server is split into three layers. Imports go **one way only**: `transport -> tools -> core`.

| Layer     | Folder           | Responsibility                                          | May import                        |
| --------- | ---------------- | ------------------------------------------------------- | --------------------------------- |
| Transport | `src/transport/` | HTTP, auth, MCP server construction                     | tools, core/errors                |
| Tools     | `src/tools/`     | Thin MCP handlers: validate, call a service, map errors | core (via context), tools/schemas |
| Core      | `src/core/`      | Sandbox, guards, locks, git, handoff, audit             | core only                         |

Core has no knowledge of MCP or HTTP, so it can be unit-tested without a server.

---

## 5. Folder structure

```
mcp-workspace/
|- src/
|  |- index.ts                  # entry: load config, build app, listen
|  |- config.ts                 # env -> typed, frozen Config (zod-parsed)
|  |
|  |- transport/
|  |  |- app.ts                 # express app, mounts POST /mcp
|  |  |- auth.ts                # bearer token -> agentId
|  |  '- createServer.ts        # builds McpServer, registers tools
|  |
|  |- tools/
|  |  |- index.ts               # registerAllTools(server, ctx)
|  |  |- context.ts             # ToolContext type
|  |  |- schemas.ts             # shared zod pieces
|  |  |- files.ts               # file tools
|  |  |- handoff.ts             # handoff tools
|  |  '- git.ts                 # git-lite tools
|  |
|  '- core/
|     |- sandbox.ts             # resolveSafePath(), deny-list
|     |- fsOps.ts               # safe read/write/move/delete
|     |- guards.ts              # size cap, text-only, sha256 check
|     |- locks.ts               # per-file mutex
|     |- gitRunner.ts           # execFile("git", [...]) wrapper
|     |- handoffStore.ts        # frontmatter parse/serialize, naming
|     |- audit.ts               # JSONL append logger
|     |- errors.ts              # typed errors
|     '- services.ts            # createServices(config)
|
|- test/
|  |- core/    sandbox / guards / locks / handoffStore tests
|  |- tools/   files / git / handoff tests
|  '- e2e/     http.test.ts
|
|- workspace/                   # sandbox root, its own git repo
|  '- .handoffs/
|- logs/audit.jsonl             # gitignored
|- ecosystem.config.cjs         # pm2: server + ngrok
|- .env  .env.example
|- package.json  tsconfig.json  vitest.config.ts
|- architecture.md  design.md  REPORT.md
```

---

## 6. Dependency rules

```
index.ts
   |
   |--> config.ts
   |
   '--> transport/app.ts
           |--> transport/auth.ts
           '--> transport/createServer.ts
                   '--> tools/index.ts
                           |--> tools/files.ts ---+
                           |--> tools/handoff.ts -+--> tools/schemas.ts
                           '--> tools/git.ts -----+
                                   |
                                   v  (via ToolContext.services)
                         core/services.ts
                           |--> fsOps ----> sandbox, guards, locks
                           |--> handoffStore ----> fsOps
                           |--> gitRunner ----> sandbox
                           '--> audit
                                   |
                                   v
                            core/errors.ts  (imported by everyone)
```

**Rules** (enforce with `dependency-cruiser` or ESLint `no-restricted-imports`):

1. `core/` never imports from `tools/` or `transport/`, and never imports the MCP SDK.
2. `tools/` never imports `fs`, `path` for resolution, or `child_process`. They call `ctx.services.*` only.
3. Only `core/sandbox.ts` resolves paths. Everything else calls it.
4. Only `core/gitRunner.ts` spawns processes, and only with `execFile` and an argument array.
5. Only `transport/` knows about HTTP. Tools get `agentId` through context, never a request object.

---

## 7. Wiring

`core/services.ts` is the only place core pieces are assembled. It runs once at startup. Each request then builds a small `ToolContext`.

```ts
// core/services.ts
export function createServices(cfg: Config) {
  const audit = createAudit(cfg.auditPath);
  const sandbox = createSandbox(cfg.workspaceRoot);
  const locks = createLocks();
  const fs = createFsOps({ sandbox, locks, limits: cfg.limits });
  return {
    fs,
    handoff: createHandoffStore({ fs }),
    git: createGitRunner({ sandbox, root: cfg.workspaceRoot }),
    audit,
  };
}

// tools/context.ts
export type ToolContext = { agentId: string; services: Services };
```

Dependencies are passed in rather than imported as singletons, so tests can build `services` against a temp directory.

---

## 8. Request flow: `write_file`

| Step | File                        | What happens                                                    |
| ---- | --------------------------- | --------------------------------------------------------------- |
| 1    | `transport/app.ts`          | `POST /mcp` arrives via ngrok                                   |
| 2    | `transport/auth.ts`         | Bearer token mapped to `agentId`, otherwise 401                 |
| 3    | `transport/createServer.ts` | Fresh `McpServer` per request, builds `ToolContext`             |
| 4    | `tools/files.ts`            | zod validates `{ path, content, expected_sha256? }`             |
| 5    | `core/fsOps.ts`             | `sandbox.resolveSafePath()`, then `locks.acquire(path)`         |
| 6    | `core/guards.ts`            | Size cap, text-only check, hash match against `expected_sha256` |
| 7    | `core/fsOps.ts`             | Writes the file, releases the lock                              |
| 8    | `core/audit.ts`             | Appends `{ ts, agentId, tool, path, ok }` to the audit log      |
| 9    | `tools/files.ts`            | Maps core errors to an MCP `isError` result                     |

---

## 9. Deployment

```
pm2
 |- app "mcp-server"   node dist/index.js        (port 3000)
 '- app "ngrok"        ngrok http 3000 --domain=<static-domain>
```

- `pm2 startup` and `pm2 save` so both processes come back after a reboot.
- Server is **stateless** (new MCP server instance per request), so `pm2 restart` loses nothing.
- Secrets (agent tokens, workspace root) come from `.env`, never from the repo.

---

## 10. Cross-cutting concerns

| Concern          | Where it lives                                          |
| ---------------- | ------------------------------------------------------- |
| Authentication   | `transport/auth.ts`                                     |
| Input validation | `tools/schemas.ts` + each tool's zod schema             |
| Path safety      | `core/sandbox.ts` (single choke point)                  |
| Concurrency      | `core/locks.ts` + sha256 check in `core/guards.ts`      |
| Auditing         | `core/audit.ts`, called from tools after each operation |
| Error mapping    | `core/errors.ts` (typed) -> `tools/*` (MCP result)      |

---

## 11. Key decisions and trade-offs

**ADR-001: three layers with one-way imports (chosen)**

- Vertical slices (files / handoff / git) were rejected because handoff and git both need safe file access, so slices would either import each other or duplicate sandbox code.
- A single `server.ts` was rejected because security logic would be untestable in isolation.
- Cost of the chosen option: about 20 small files and some context-passing boilerplate.
- Revisit if per-agent directories are added: `createSandbox(root)` is already a factory, so it can take a root per agent.

---

## 12. Milestone to file map

| Milestone   | Files created or changed                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 Skeleton | `index.ts`, `config.ts`, `transport/app.ts`, `transport/createServer.ts`, `tools/index.ts`, `tools/files.ts` (`list_files`), minimal `core/sandbox.ts` |
| M2 Sandbox  | full `sandbox.ts`, `fsOps.ts`, `errors.ts`, `services.ts`, `tools/schemas.ts`, remaining file tools, sandbox tests                                     |
| M3 Deploy   | `transport/auth.ts`, `ecosystem.config.cjs`, `.env.example`, e2e test                                                                                  |
| M4 Protocol | `guards.ts`, `locks.ts`, `gitRunner.ts`, `handoffStore.ts`, `audit.ts`, `tools/handoff.ts`, `tools/git.ts`                                             |
| M5 Prove it | `REPORT.md`, audit excerpts, demo script                                                                                                               |

See `design.md` for tool contracts, algorithms and the test plan.
