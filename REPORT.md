# Report: Workspace File-Server MCP Connector

## 1. Stack and why

| Layer | Choice | Justification |
|---|---|---|
| Runtime/SDK | Node.js 22 + official TypeScript SDK | The reference implementation of the protocol; transport and JSON-RPC handling come for free, and types catch schema mistakes early. |
| Transport | Streamable HTTP (stateless) | Required for remote clients. Stateless mode (new server+transport per request) removes session bookkeeping; durable state lives on disk, which is the point of the handoff protocol anyway. |
| Validation | zod on every tool input | Bad input is rejected before it reaches file or git code; the same schemas generate the JSON Schema clients see. |
| Exposure | ngrok, static domain | A stable HTTPS URL means the client config never changes after a restart. |
| Process manager | pm2 | Verified: after `kill -9` the process came back under a new PID and `/health` answered again. |
| VCS | git on the host, inside the workspace | Gives every agent edit an undo and an audit trail. |
| Testing | `node:test` (37 tests) → MCP Inspector → scripted SDK client → real client | Cheap, dependency-free unit tests for the dangerous part (paths), then protocol-level checks. |

## 2. Tool design choices

- **Few, orthogonal tools.** 12 tools in three groups. Each does one thing, so the model rarely has to guess which to use.
- **Errors are returned, not thrown.** Failures come back as `isError` results with a plain message ("PLAN_LOG.md is append-only; use handoff_append"), so the model can self-correct instead of seeing a protocol failure.
- **`str_replace` demands a unique match.** Zero or multiple matches fail. This prevents silent edits to the wrong place.
- **Optimistic locking (`if_version`).** `read_file`/`write_file` return a short content hash; passing it back makes stale overwrites fail. Chosen over file locks because agents disconnect without releasing locks.
- **Handoff as first-class tools.** `handoff_read` is described as "START OF EVERY SESSION" so the model is steered to it. Logs are append-only via `handoff_append` (timestamp + author added by the server) so a confused agent cannot erase history. PROJECT_STATE stays freely writable because it is meant to be overwritten with current truth.
- **Tool annotations** (`readOnlyHint`, `destructiveHint`) let clients prompt for approval on risky calls.
- **git-lite, not full git.** Status, diff, log, commit only. No push, branch, reset or checkout, which removes whole classes of damage.

## 3. Security tradeoffs

| Risk | Mitigation | Remaining gap / tradeoff |
|---|---|---|
| Path traversal | Resolve against root, `path.relative` containment check (not string prefix), reject absolute/NUL, the sandbox attack tests | Symlink check happens at resolve time, so a race (TOCTOU) where something swaps a symlink between check and use is theoretically possible; mitigated because only the server writes the workspace and the AI can't create symlinks. |
| Unauthorized network access | Shared bearer token, constant-time compare, bind 127.0.0.1 | A static token has no expiry, per-client scope or rotation; if leaked, the holder has full workspace access. Production would use OAuth. Some hosted clients (e.g. consumer chat apps) may not allow custom auth headers; Claude Code and Inspector do. |
| Destructive/bad writes | Append-only logs, protected `.git`, 1 MB cap, no directory delete, if_version | `write_file` can still overwrite any ordinary file; git history is the recovery path. `git_commit` stages everything, so it can commit junk. |
| Command injection | `execFile` with argument arrays, no shell | None known; git is the only subprocess. |
| Data exposure | Workspace is the only readable area | Anything in the workspace is sent to the model provider via the client. Don't put secrets there. |
| Denial of service | Body limit 2 MB, read/write caps, search result cap | No rate limiting; a token holder could still hammer the server. ngrok's free tier adds some protection. |
| Prompt injection | Tools are narrow; no network, no shell | A malicious file could contain instructions the agent follows. The agent can only act inside the sandbox, which bounds the damage, but it can still edit or delete workspace files. |
| Public exposure | Tunnel only while needed | A public endpoint with write access always carries risk; stop ngrok when not in use. |

## 4. Verification summary

- 37 unit tests pass (sandbox escapes incl. symlinks and `ws-evil` sibling, guards, locking, handoff, git, injection).
- Server rejects missing/wrong tokens with 401.
- Scripted 2-session run over real HTTP: Session 2 resumed purely from handoff files, completed the task, and 5/5 deliberate attacks (traversal, absolute path, append-only overwrite, `.git` write, stale version) were refused. See `DEMO_TRANSCRIPT.md`.
- pm2 auto-restart verified with `kill -9`.
- **Not yet done (needs your machine):** ngrok tunnel and a run with a real LLM client. Add that transcript and a short note on what the model did well/badly.
