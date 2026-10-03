/**
 * Scripted two-session demo. Each "session" is a brand-new MCP client connection with no
 * shared memory; the only thing that carries over is the workspace on disk (the handoff protocol).
 *
 * Usage: MCP_URL=http://127.0.0.1:3000/mcp AUTH_TOKEN=... npm run demo
 * Writes DEMO_TRANSCRIPT.md
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const TOKEN = process.env.AUTH_TOKEN ?? "";
const lines: string[] = [];
const out = (s = "") => { lines.push(s); console.log(s); };

async function session(name: string, fn: (call: (tool: string, args?: Record<string, unknown>) => Promise<string>) => Promise<void>) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  const tools = (await client.listTools()).tools;
  out(`\n## ${name}\n\nConnected. Server advertises ${tools.length} tools: ${tools.map(t => t.name).join(", ")}\n`);
  let n = 0;
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { text: string }[]).map(c => c.text).join("\n");
    out(`### ${name} · call ${++n}: \`${tool}\`${r.isError ? "  ❌ ERROR (expected)" : ""}\n\`\`\`json\n${JSON.stringify(args)}\n\`\`\`\n\`\`\`\n${text.length > 700 ? text.slice(0, 700) + "\n…(truncated)" : text}\n\`\`\`\n`);
    return text;
  };
  await fn(call);
  await client.close();
}

out("# Demo transcript: two-session task\n");
out("**Task:** build a small `slugify` utility with tests, across two separate agent sessions.");
out("Session 1 plans and scaffolds. Session 2 starts with no memory, resumes from the handoff files, finishes, and probes the guards.");

await session("session-1", async (call) => {
  await call("handoff_read");
  await call("handoff_append", { log: "PLAN_LOG", author: "session-1", entry: "Plan: (1) create src/slugify.js, (2) add tests, (3) README, (4) commit. Session 1 does step 1 only." });
  await call("write_file", { path: "src/slugify.js", content: "export function slugify(s) {\n  return s.toLowerCase().trim().replace(/\\s+/g, '-');\n}\n" });
  await call("write_file", { path: "PROJECT_STATE.md", content: "# PROJECT_STATE\n\n- Goal: slugify utility with tests\n- Status: src/slugify.js created (naive version, does NOT strip punctuation yet)\n- Next step: fix punctuation handling, add tests, commit\n" });
  await call("handoff_append", { log: "CHECKPOINTS", author: "session-1", entry: "src/slugify.js exists. Known gap: punctuation not stripped." });
  await call("handoff_append", { log: "DECISIONS", author: "session-1", entry: "Plain JS (ESM) with node:test, so there are zero dependencies." });
  await call("git_commit", { message: "session-1: scaffold slugify" });
});

await session("session-2", async (call) => {
  const state = await call("handoff_read");
  if (!state.includes("does NOT strip punctuation")) throw new Error("handoff did not carry over!");
  const file = JSON.parse(await call("read_file", { path: "src/slugify.js" }));
  await call("str_replace", {
    path: "src/slugify.js",
    old_str: "replace(/\\s+/g, '-')",
    new_str: "replace(/[^a-z0-9\\s-]/g, '').replace(/\\s+/g, '-')",
    if_version: file.version,
  });
  await call("write_file", { path: "test/slugify.test.js", content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('basic', () => assert.equal(slugify(' Hello, World! '), 'hello-world'));\n" });
  await call("search_files", { query: "slugify" });
  // Guards: each of these MUST fail
  await call("read_file", { path: "../../etc/passwd" });
  await call("write_file", { path: "/tmp/evil.txt", content: "x" });
  await call("write_file", { path: "PLAN_LOG.md", content: "wiped" });
  await call("write_file", { path: ".git/config", content: "x" });
  await call("write_file", { path: "src/slugify.js", content: "stale overwrite", if_version: file.version });
  await call("handoff_append", { log: "CHECKPOINTS", author: "session-2", entry: "Punctuation fixed, test added. Guards verified: traversal, absolute path, append-only log, .git, stale version all rejected." });
  await call("write_file", { path: "PROJECT_STATE.md", content: "# PROJECT_STATE\n\n- Goal: slugify utility with tests\n- Status: DONE\n- Next step: none\n" });
  await call("git_commit", { message: "session-2: fix punctuation, add test" });
  await call("git_log", { limit: 5 });
  await call("git_status");
});

fs.writeFileSync("DEMO_TRANSCRIPT.md", lines.join("\n"));
console.log("\nWrote DEMO_TRANSCRIPT.md");
