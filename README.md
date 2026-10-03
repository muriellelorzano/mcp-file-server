# MCP Workspace File Server

A sandboxed **Model Context Protocol** server that lets an AI agent read, edit, search and version-control files in one folder, and carry work across sessions using a four-file handoff protocol.

**Stack:** Node.js 22 · official TypeScript MCP SDK · Streamable HTTP · zod validation · ngrok (static domain) · pm2 · git · MCP Inspector.

```
AI model ↔ MCP client (Claude Code, Inspector, ...) ──HTTPS──▶ ngrok ──▶ this server ──▶ ./workspace (git repo)
```

## Tools (12)

| Group | Tool | What it does |
|---|---|---|
| Files | `list_files` | List a directory (optionally recursive) |
| | `read_file` | Read text; returns a `version` hash |
| | `write_file` | Create/overwrite; optional `if_version` lock |
| | `str_replace` | Replace exactly one match; optional `if_version` |
| | `delete_file` | Delete one file (no directories) |
| | `search_files` | Case-insensitive text search with line numbers |
| Handoff | `handoff_read` | Returns PROJECT_STATE, PLAN_LOG, CHECKPOINTS, DECISIONS |
| | `handoff_append` | Timestamped append to PLAN_LOG / CHECKPOINTS / DECISIONS |
| Git-lite | `git_status`, `git_diff`, `git_log`, `git_commit` | Inspect and commit the workspace |

## Security model

1. **Sandbox:** every path is resolved against `WORKSPACE_ROOT`. Rejected: `..` escapes, absolute paths, NUL bytes, sibling-prefix tricks (`/ws-evil`), and symlinks that point outside.
2. **Write guards:** `.git/` is untouchable; `PLAN_LOG.md`, `CHECKPOINTS.md`, `DECISIONS.md` are append-only; `PROJECT_STATE.md` can't be deleted; 1 MB write cap; directories can't be deleted.
3. **Bearer token** on every request to `/mcp` (constant-time compare). The server refuses to start without one.
4. **Binds to 127.0.0.1** only; the tunnel is the sole public path.
5. **git runs via `execFile`**, never a shell, so commit messages can't inject commands.
6. **Optimistic locking:** `if_version` stops an agent from overwriting changes it hasn't seen.

## Setup

```bash
git clone <your-repo> && cd mcp-file-server
npm install
cp .env.example .env            # then set AUTH_TOKEN:  openssl rand -hex 32
npm test                        # 37 tests, including path-escape attacks
npm run dev                     # http://127.0.0.1:3000/mcp
```

### Milestone checks

- **M1/M2, MCP Inspector:** `npm run inspector`, choose *Streamable HTTP*, URL `http://127.0.0.1:3000/mcp`, add header `Authorization: Bearer <AUTH_TOKEN>`, then *List Tools* and call `list_files`.
- **M3, deploy:**
  ```bash
  npm run build
  npm i -g pm2 ngrok            # or install ngrok from ngrok.com
  pm2 start ecosystem.config.cjs
  pm2 save && pm2 startup       # survive reboots (run the command it prints)
  ngrok http --url=YOUR-NAME.ngrok-free.app 3000     # older CLI: --domain=
  ```
  Your endpoint is `https://YOUR-NAME.ngrok-free.app/mcp`. Verify: `curl https://YOUR-NAME.ngrok-free.app/health`.
- **Connect a real client** (Claude Code supports custom headers):
  ```bash
  claude mcp add --transport http workspace https://YOUR-NAME.ngrok-free.app/mcp \
    --header "Authorization: Bearer <AUTH_TOKEN>"
  ```
- **M4/M5, scripted demo:** `AUTH_TOKEN=<token> npm run demo` writes `DEMO_TRANSCRIPT.md`.

## Running the handoff protocol with a real agent

Start every session with this instruction:

> Call `handoff_read` first and resume from PROJECT_STATE. Log your plan with `handoff_append` (PLAN_LOG). When you finish a verified step, append a CHECKPOINT, update PROJECT_STATE.md, and `git_commit`. Record any choice and its reason in DECISIONS.

Run Session 1, close the chat, open a **new** chat (Session 2) with the same instruction, and confirm it continues without you re-explaining. Save the tool-call log as your transcript.

## Layout

```
src/sandbox.ts   path resolution + write guards (the security core)
src/ops.ts       all file / handoff / git logic (pure, unit-tested)
src/server.ts    MCP tool registration + zod schemas
src/http.ts      Express + Streamable HTTP + bearer auth
src/index.ts     config + boot
test/            37 tests (sandbox attacks, locking, handoff, git)
scripts/demo.ts  scripted two-session demo
```
