# Demo transcript: two-session task

**Task:** build a small `slugify` utility with tests, across two separate agent sessions.
Session 1 plans and scaffolds. Session 2 starts with no memory, resumes from the handoff files, finishes, and probes the guards.

## session-1

Connected. Server advertises 12 tools: list_files, read_file, write_file, str_replace, delete_file, search_files, handoff_read, handoff_append, git_status, git_diff, git_log, git_commit

### session-1 · call 1: `handoff_read`
```json
{}
```
```
{
  "PROJECT_STATE.md": "# PROJECT_STATE\n\n_Current truth about the project. Overwrite freely; keep it short._\n\n- Goal: (not set)\n- Status: not started\n- Next step: (not set)\n",
  "PLAN_LOG.md": "# PLAN_LOG\n\n_Append-only. One entry per plan or plan change._\n",
  "CHECKPOINTS.md": "# CHECKPOINTS\n\n_Append-only. What is done and verified, so the next session can resume._\n",
  "DECISIONS.md": "# DECISIONS\n\n_Append-only. Decisions and the reasons for them._\n"
}
```

### session-1 · call 2: `handoff_append`
```json
{"log":"PLAN_LOG","author":"session-1","entry":"Plan: (1) create src/slugify.js, (2) add tests, (3) README, (4) commit. Session 1 does step 1 only."}
```
```
{
  "file": "PLAN_LOG.md",
  "appended": "2026-10-03T18:19:02.230Z"
}
```

### session-1 · call 3: `write_file`
```json
{"path":"src/slugify.js","content":"export function slugify(s) {\n  return s.toLowerCase().trim().replace(/\\s+/g, '-');\n}\n"}
```
```
{
  "path": "src/slugify.js",
  "version": "8488fdd24b9e1d7e",
  "bytes": 85
}
```

### session-1 · call 4: `write_file`
```json
{"path":"PROJECT_STATE.md","content":"# PROJECT_STATE\n\n- Goal: slugify utility with tests\n- Status: src/slugify.js created (naive version, does NOT strip punctuation yet)\n- Next step: fix punctuation handling, add tests, commit\n"}
```
```
{
  "path": "PROJECT_STATE.md",
  "version": "41a8d6b4e3a6903b",
  "bytes": 190
}
```

### session-1 · call 5: `handoff_append`
```json
{"log":"CHECKPOINTS","author":"session-1","entry":"src/slugify.js exists. Known gap: punctuation not stripped."}
```
```
{
  "file": "CHECKPOINTS.md",
  "appended": "2026-10-03T18:19:02.269Z"
}
```

### session-1 · call 6: `handoff_append`
```json
{"log":"DECISIONS","author":"session-1","entry":"Plain JS (ESM) with node:test, so there are zero dependencies."}
```
```
{
  "file": "DECISIONS.md",
  "appended": "2026-10-03T18:19:02.288Z"
}
```

### session-1 · call 7: `git_commit`
```json
{"message":"session-1: scaffold slugify"}
```
```
e7a2c27 session-1: scaffold slugify
```


## session-2

Connected. Server advertises 12 tools: list_files, read_file, write_file, str_replace, delete_file, search_files, handoff_read, handoff_append, git_status, git_diff, git_log, git_commit

### session-2 · call 1: `handoff_read`
```json
{}
```
```
{
  "PROJECT_STATE.md": "# PROJECT_STATE\n\n- Goal: slugify utility with tests\n- Status: src/slugify.js created (naive version, does NOT strip punctuation yet)\n- Next step: fix punctuation handling, add tests, commit\n",
  "PLAN_LOG.md": "# PLAN_LOG\n\n_Append-only. One entry per plan or plan change._\n\n## 2026-10-03T18:19:02.230Z — session-1\nPlan: (1) create src/slugify.js, (2) add tests, (3) README, (4) commit. Session 1 does step 1 only.\n",
  "CHECKPOINTS.md": "# CHECKPOINTS\n\n_Append-only. What is done and verified, so the next session can resume._\n\n## 2026-10-03T18:19:02.269Z — session-1\nsrc/slugify.js exists. Known gap: punctuation not stripped.\n",
  "DECISIONS.md": "# DECISI
…(truncated)
```

### session-2 · call 2: `read_file`
```json
{"path":"src/slugify.js"}
```
```
{
  "content": "export function slugify(s) {\n  return s.toLowerCase().trim().replace(/\\s+/g, '-');\n}\n",
  "version": "8488fdd24b9e1d7e"
}
```

### session-2 · call 3: `str_replace`
```json
{"path":"src/slugify.js","old_str":"replace(/\\s+/g, '-')","new_str":"replace(/[^a-z0-9\\s-]/g, '').replace(/\\s+/g, '-')","if_version":"8488fdd24b9e1d7e"}
```
```
{
  "path": "src/slugify.js",
  "version": "22e95ab41e2211e9"
}
```

### session-2 · call 4: `write_file`
```json
{"path":"test/slugify.test.js","content":"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('basic', () => assert.equal(slugify(' Hello, World! '), 'hello-world'));\n"}
```
```
{
  "path": "test/slugify.test.js",
  "version": "7ef4c46bd70d2e4c",
  "bytes": 194
}
```

### session-2 · call 5: `search_files`
```json
{"query":"slugify"}
```
```
[
  {
    "file": "CHECKPOINTS.md",
    "line": 6,
    "text": "src/slugify.js exists. Known gap: punctuation not stripped."
  },
  {
    "file": "PLAN_LOG.md",
    "line": 6,
    "text": "Plan: (1) create src/slugify.js, (2) add tests, (3) README, (4) commit. Session 1 does step 1 only."
  },
  {
    "file": "PROJECT_STATE.md",
    "line": 3,
    "text": "- Goal: slugify utility with tests"
  },
  {
    "file": "PROJECT_STATE.md",
    "line": 4,
    "text": "- Status: src/slugify.js created (naive version, does NOT strip punctuation yet)"
  },
  {
    "file": "src/slugify.js",
    "line": 1,
    "text": "export function slugify(s) {"
  },
  {
    "file": "test/slugify.test.js",
    "line": 
…(truncated)
```

### session-2 · call 6: `read_file`  ❌ ERROR (expected)
```json
{"path":"../../etc/passwd"}
```
```
Error: Path escapes the workspace: ../../etc/passwd
```

### session-2 · call 7: `write_file`  ❌ ERROR (expected)
```json
{"path":"/tmp/evil.txt","content":"x"}
```
```
Error: Absolute paths are not allowed; use a path relative to the workspace
```

### session-2 · call 8: `write_file`  ❌ ERROR (expected)
```json
{"path":"PLAN_LOG.md","content":"wiped"}
```
```
Error: PLAN_LOG.md is append-only; use the handoff_append tool
```

### session-2 · call 9: `write_file`  ❌ ERROR (expected)
```json
{"path":".git/config","content":"x"}
```
```
Error: The .git directory is protected; use the git_* tools
```

### session-2 · call 10: `write_file`  ❌ ERROR (expected)
```json
{"path":"src/slugify.js","content":"stale overwrite","if_version":"8488fdd24b9e1d7e"}
```
```
Error: Version conflict: file is at 22e95ab41e2211e9, you sent 8488fdd24b9e1d7e. Re-read and retry.
```

### session-2 · call 11: `handoff_append`
```json
{"log":"CHECKPOINTS","author":"session-2","entry":"Punctuation fixed, test added. Guards verified: traversal, absolute path, append-only log, .git, stale version all rejected."}
```
```
{
  "file": "CHECKPOINTS.md",
  "appended": "2026-10-03T18:19:02.394Z"
}
```

### session-2 · call 12: `write_file`
```json
{"path":"PROJECT_STATE.md","content":"# PROJECT_STATE\n\n- Goal: slugify utility with tests\n- Status: DONE\n- Next step: none\n"}
```
```
{
  "path": "PROJECT_STATE.md",
  "version": "5da4d1c07568d422",
  "bytes": 85
}
```

### session-2 · call 13: `git_commit`
```json
{"message":"session-2: fix punctuation, add test"}
```
```
806d1de session-2: fix punctuation, add test
```

### session-2 · call 14: `git_log`
```json
{"limit":5}
```
```
806d1de 2026-10-03 session-2: fix punctuation, add test
e7a2c27 2026-10-03 session-1: scaffold slugify
9b7263e 2026-10-03 Initial handoff files
```

### session-2 · call 15: `git_status`
```json
{}
```
```
## main
```
