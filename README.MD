# MCP Workspace Server

A shared-workspace [Model Context Protocol](https://modelcontextprotocol.io) server. It lets AI agents read, write, and hand off work inside one sandboxed folder, with a small set of git tools for history.

- **Transport:** Streamable HTTP (stateless), served by Express
- **Stack:** Node.js, TypeScript, official MCP TypeScript SDK, zod, Vitest
- **Exposure:** ngrok tunnel to a static domain, process managed by PM2
- **Identity:** one key per agent, mapped to an agent id (`agent-a`, `agent-b`, ...)

## Features

- 14 tools: file, handoff, and git-lite
- Path sandbox: every path resolves inside `WORKSPACE_ROOT`, symlinks are checked, secrets are deny-listed
- Optimistic concurrency: overwrites and deletes need the file's `sha256`, so agents cannot clobber each other's work
- Per-file locking with a timeout
- Agent handoffs written as Markdown files in `workspace/.handoffs/`
- Per-agent git commit authorship
- JSON Lines audit log of every tool call, including blocked attempts
- No arbitrary command execution. The only subprocess is `git`, run without a shell

## How it works

```
Claude / Gemini / Inspector
        |  HTTPS  POST /mcp/<key>   or   POST /mcp + Authorization: Bearer <key>
        v
ngrok tunnel  (https://<your-domain>)
        |  forwards to localhost:3000
        v
Express app (listens on 127.0.0.1 only)
        |  requireAuth: key -> agent id, otherwise 401
        v
MCP server (a new one per request, knows the agent id)
        |
        v
Tools (zod-validated) -> core (sandbox, guards, locks, git, audit) -> workspace/
```

1. A client sends an MCP request to the public URL.
2. ngrok forwards it to `http://127.0.0.1:3000`.
3. `requireAuth` reads the key from the `Authorization: Bearer` header or from the `/mcp/<key>` URL path, compares it against `AGENT_TOKENS`, and resolves it to an agent id.
4. A fresh MCP server is created for that request with the agent id attached.
5. The tool validates its input, calls a core service, and the sandbox confirms the path is allowed.
6. The result is returned, and one record is appended to the audit log.

The server is stateless, so `pm2 restart` loses nothing.

## Requirements

- Node.js 20 or newer (uses `--env-file`)
- git (for the git tools and workspace history)
- [ngrok](https://ngrok.com) account and agent (for remote clients)
- [PM2](https://pm2.keymetrics.io) (optional, for running in the background)

## Quick start

```bash
npm install
cp .env.example .env     # Windows PowerShell: copy .env.example .env
```

Generate one key per agent. Hex keeps keys URL-safe:

```bash
openssl rand -hex 32
```

```powershell
# PowerShell alternative
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Edit `.env` so each agent has its own key:

```
PORT=3000
WORKSPACE_ROOT=./workspace
AGENT_TOKENS=<key-for-agent-a>:agent-a,<key-for-agent-b>:agent-b
```

Build and run:

```bash
npm run build
npm start
```

Check it:

```bash
curl http://127.0.0.1:3000/healthz
# {"ok":true}
```

On Windows PowerShell, use `curl.exe`, because plain `curl` is an alias for a different command.

For development with auto-reload: `npm run dev`.

## Configuration

All settings come from environment variables (loaded from `.env` by `--env-file`) and are validated with zod at startup. A bad value stops the server with an error.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_TOKENS` | required | `key:agent-id` pairs, comma separated |
| `PORT` | `3000` | Local port. The server binds to `127.0.0.1` only |
| `WORKSPACE_ROOT` | `./workspace` | Sandbox root |
| `AUDIT_PATH` | `./logs/audit.jsonl` | Audit log file |
| `MAX_FILE_BYTES` | `262144` | Largest file `write_file` will accept (256 KB) |
| `MAX_READ_BYTES` | `524288` | Most bytes `read_file` returns (512 KB) |
| `MAX_LIST_ENTRIES` | `500` | Cap on list and search results |
| `MAX_SEARCH_FILES` | `2000` | Cap on files scanned by `search_files` |
| `MAX_DIFF_BYTES` | `100000` | Cap on `git_diff` output |
| `LOCK_TIMEOUT_MS` | `3000` | Max wait for a per-file lock |
| `GIT_TIMEOUT_MS` | `10000` | Timeout for each git command |

`AGENT_TOKENS` rules:

- Format: `key1:agent-a,key2:agent-b`, with no quotes and no spaces
- Keys: at least 32 characters, only `A-Z a-z 0-9 . _ ~ -` (so they are safe in a URL)
- Keys must be unique, and agent ids must be unique
- Agent ids: lowercase letters, digits, and `-`, up to 32 characters

Numeric settings must be plain digits. Units, comments on the same line, or separators such as `100_000` become `NaN` and fail validation.

## Tools

All paths are relative to the workspace root.

### File tools

| Tool | What it does |
| --- | --- |
| `list_files` | List files and directories. Optional `path` and `recursive` |
| `read_file` | Read a text file. Returns `content` and the `sha256` of the full file |
| `search_files` | Case-insensitive text search with line numbers |
| `write_file` | Create a file, or overwrite one when given the current `expected_sha256`. `create_only` refuses to overwrite |
| `edit_file` | Replace exactly one occurrence of `old_string` |
| `move_file` | Move a file without overwriting the destination |
| `delete_file` | Delete a file. Requires the correct `expected_sha256` |

### Handoff tools

| Tool | What it does |
| --- | --- |
| `write_handoff` | Leave a note for another agent: `to`, `task`, `status` (`ready`, `blocked`, `done`), `done`, `next`, optional `open_questions` and `files` |
| `list_handoffs` | List handoffs, filtered by `to`, `from`, or `status` |
| `read_handoff` | Read one handoff by id |

The `from` field is always taken from the authenticated agent. An agent cannot forge a handoff from someone else.

### Git tools

| Tool | What it does |
| --- | --- |
| `git_status` | Branch and changed files |
| `git_diff` | Diff of the workspace or one path, optionally staged |
| `git_commit` | Commit with a message, authored as `<agent-id> <agent-id@workspace.local>` |
| `git_log` | Recent commits, optionally for one path |

Git is intentionally small: there is no push, pull, checkout, reset, branch, or config tool.

## Connecting clients

The server needs two things running: the Node process (PM2 or `npm start`) and the ngrok tunnel. Use the same key you put in `AGENT_TOKENS`.

First test the public URL. A `200` means clients can reach it.

```bash
curl -i -X POST "https://<your-domain>/mcp/<key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

On PowerShell, use `curl.exe` and escape the inner quotes as `\"`.

### Claude (custom connector)

Claude's custom connector dialog did not offer a header field here, so the key goes in the URL path.

1. In claude.ai, open **Settings**, then **Connectors**, then **Add custom connector**.
2. Name: `workspace`
3. URL: `https://<your-domain>/mcp/<key>`
4. Leave the OAuth client ID and secret empty, then click **Add**.
5. In a new chat, switch the connector on and ask: *"Use list_files on the workspace with path `.`"*

Claude does not let you edit a connector's authentication settings after creation. If the key or URL changes, delete the connector and add it again.

If your account's dialog has a **Request headers** section, you can instead use the plain `https://<your-domain>/mcp` URL with the header `Authorization: Bearer <key>`.

### MCP Inspector

```bash
npm run inspect
```

1. Add a server with transport **Streamable HTTP**.
2. URL: `http://localhost:3000/mcp` or `https://<your-domain>/mcp`
3. Header: `Authorization: Bearer <key>`
4. Connect, open **Tools**, and run `list_files` with path `.`

## Deployment

### PM2

`ecosystem.config.cjs` runs the compiled server with `.env` loaded:

```bash
npm run build
pm2 start ecosystem.config.cjs --update-env
pm2 status
pm2 logs mcp-server --lines 20 --nostream
```

| Task | Command |
| --- | --- |
| Restart after changing `.env` or code | `npm run build` then `pm2 restart mcp-server --update-env` |
| Stop | `pm2 stop mcp-server` |
| Save the process list | `pm2 save` |
| Restore it after a PM2 daemon restart | `pm2 resurrect` |

Rebuild only when you change files in `src/`. A `.env` change needs only a restart with `--update-env`.

To start at login on Windows, use `pm2 save` together with a startup tool such as `pm2-windows-startup` (`pm2 startup` is not supported on Windows). A PM2 status of `online` only means the process exists. Always confirm with `healthz`.


### ngrok

Run the tunnel in its own terminal to expose local port 3000:

```bash
ngrok http 3000

```
Copy the address from the **Forwarding** line. The Web Interface line (`http://127.0.0.1:4040`) is only a local dashboard for inspecting requests.

To keep the same address across restarts without updating your Claude connector, use a static domain instead:

```bash
ngrok http --url=<your-domain>.ngrok-free.dev 3000

```
If you install ngrok from the Microsoft Store, its `WindowsApps` shortcut cannot be launched by PM2. Run ngrok from a terminal, install it as an ngrok service, or download the zip from ngrok.com and point PM2 at that `ngrok.exe`.

```


## Security model

- **Authentication:** every `/mcp` request needs a valid key. Keys are compared as SHA-256 digests with `timingSafeEqual`, and every key is always checked so timing does not reveal a match. Failures return `401` with no detail and no `WWW-Authenticate` header, so clients do not start an OAuth flow.
- **Keys never logged:** rejected requests log only the method and client IP, because with URL keys the path is the credential.
- **Public surface:** the server listens on `127.0.0.1` only. The tunnel is the single entry point, and `/healthz` reveals nothing except that the process is up.
- **Sandbox:** the single choke point is `core/sandbox.ts`. It rejects absolute paths, null bytes, `..` escapes, over-long paths, and symlinks that resolve outside the root.
- **Deny-list:** `.git`, `.env`, `.env.*`, and `node_modules` cannot be accessed through file tools. `.handoffs/` is read-only for generic write tools.
- **Concurrency:** writes and deletes need `expected_sha256`. A stale hash returns a `ConflictError` that includes the current hash so the agent can re-read and retry.
- **Content rules:** UTF-8 text only, size-capped.
- **Subprocesses:** only `git`, via `execFile` with an argument array and a timeout. Never a shell.
- **The connector URL is a credential.** Anyone who has it can use every tool that key allows, including writes. Do not share it or post screenshots of it. Rotate a key by changing `AGENT_TOKENS`, restarting, and re-adding the connector.

Known gap: there is a small time-of-check to time-of-use window between validating a path and using it. It is reduced by per-file locking and by opening files without following symlinks where the platform allows.

## Handoffs

`write_handoff` creates `workspace/.handoffs/<from>-to-<to>-<UTC timestamp>-<suffix>.md`:

```markdown
---
id: agent-a-to-agent-b-20261011T115856572Z-d90c
from: agent-a
to: agent-b
status: ready
task: Review hello.txt
created: 2026-10-11T11:58:56Z
files:
  - hello.txt
---

## Done

- Created hello.txt

## Next

- Review it

## Open questions

- ...
```

Handoffs are append-only. To change a status, write a new handoff rather than editing an old one. IDs are generated by the server.

## Audit log

Every tool call appends one JSON line to `logs/audit.jsonl`, including blocked attempts. File contents and keys are never logged.

```json
{"ts":"2026-10-07T14:30:12.411Z","agent":"agent-a","tool":"write_file","path":"src/login.ts","ok":true}
{"ts":"2026-10-07T14:31:40.002Z","agent":"agent-b","tool":"read_file","path":"../../etc/passwd","ok":false,"error":"SandboxError"}
```

A failure to write the audit log does not crash the server. It prints to stderr instead.

## Errors

| Error | Meaning |
| --- | --- |
| `SandboxError` | Path escape, deny-listed path, or invalid path |
| `NotFoundError` | The target does not exist |
| `ConflictError` | Hash mismatch, a missing hash on overwrite, or the file already exists |
| `TooLargeError` | Over the size limit |
| `InvalidContentError` | Binary or non-UTF-8 content |
| `LockTimeoutError` | The file stayed busy past `LOCK_TIMEOUT_MS` |
| `GitError` | A git command failed |

Tool errors come back as MCP `isError` results with a readable message. Host paths are never revealed.

## Testing

```bash
npm test            # run the test suite once (Vitest)
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
npm run deps        # enforce architecture rules with dependency-cruiser
```

Tests cover the sandbox, file operations, locks, the audit log, handoffs, the git runner, tool behavior, auth, and an end-to-end HTTP run. They build against a temporary workspace, so they never touch your real `workspace/` folder.

## Project structure

```
src/
  index.ts              entry: load config, start git repo, listen
  config.ts             env -> typed, frozen config (zod)
  transport/            HTTP only: app.ts, auth.ts, createServer.ts
  tools/                thin MCP handlers: files, handoff, git, schemas
  core/                 sandbox, fsOps, guards, locks, gitRunner,
                        handoffStore, audit, errors, services
test/                   unit, tool, transport, and e2e tests
workspace/              the sandbox root (its own git repo)
logs/                   audit.jsonl
ecosystem.config.cjs    PM2 config
```

Imports go one way only: `transport -> tools -> core`. `core` never imports the MCP SDK, and `tools` never touches `fs` or `child_process`. See `ARCHITECTURE.MD` for the layers and wiring, and `DESIGN.MD` for the tool contracts and test plan.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `curl: (7) Failed to connect` to `127.0.0.1:3000`, but PM2 says `online` | The process died at startup. Run `pm2 logs mcp-server --lines 30 --nostream` and read the error log |
| `AGENT_TOKENS entry N: duplicate token` | Two agents share one key. Generate a separate key for each |
| `AGENT_TOKENS entry N: token must be at least 32 characters` | A key is too short or empty. Check the `key:agent-id` format |
| `Expected number, received nan` | A numeric variable (the error names it) has units, a comment, or a separator. Use plain digits or delete the line |
| `AGENT_TOKENS is required` | `.env` was not loaded. Run through `npm start` or PM2 with `--env-file=.env` |
| `ERR_NGROK_3200` / "endpoint is offline" | The tunnel is not running. Start `ngrok http --url=<domain> 3000` |
| `Script not found: ...WindowsApps\ngrok.exe` | PM2 cannot launch the Microsoft Store ngrok shortcut. See the ngrok section |
| `401` through ngrok but `200` locally | The key in the URL differs from the one in `AGENT_TOKENS`, or the server was not restarted with `--update-env` |
| `404` from the server on `/mcp/<key>` | The build is old. Run `npm run build` and restart |
| Claude says the server cannot be found | Both the Node process and the ngrok tunnel must be running, and the connector URL must match the live domain |
| PM2 list is empty after a reboot | The PM2 daemon restarted. Run `pm2 start ecosystem.config.cjs --update-env`, then `pm2 save` |

## Documentation

- [`ARCHITECTURE.MD`](ARCHITECTURE.MD): layers, dependency rules, wiring, deployment
- [`DESIGN.MD`](DESIGN.MD): configuration, sandbox algorithm, tool contracts, handoff format, auth, error model, test plan

