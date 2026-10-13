import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callTool,
  connectAgent,
  makeWorkspace,
  readAudit,
  TOKEN_A,
  TOKEN_B,
  type TestWorkspace,
} from "../helpers.js";

let ws: TestWorkspace;
let a: Awaited<ReturnType<typeof connectAgent>>;
let b: Awaited<ReturnType<typeof connectAgent>>;

beforeEach(async () => {
  ws = await makeWorkspace({ MAX_FILE_BYTES: "1000" });
  await ws.services.git.ensureRepo();
  a = await connectAgent(ws, "agent-a");
  b = await connectAgent(ws, "agent-b");
});
afterEach(async () => {
  await a.close();
  await b.close();
  await ws.cleanup();
});

const json = (r: { text: string }) => JSON.parse(r.text);

describe("two agents over MCP", () => {
  it("hands work from agent-a to agent-b and agent-b can read it", async () => {
    const w = await callTool(a.client, "write_file", { path: "hello.txt", content: "hi" });
    expect(w.isError).toBe(false);

    const h = await callTool(a.client, "write_handoff", {
      to: "agent-b",
      task: "Review hello.txt",
      status: "ready",
      done: ["created hello"],
      next: ["review it"],
      files: ["hello.txt"],
    });
    expect(h.isError).toBe(false);
    const { id, path: p } = json(h);

    const inbox = json(await callTool(b.client, "list_handoffs", { to: "agent-b" }));
    expect(inbox.handoffs).toHaveLength(1);
    expect(inbox.handoffs[0]).toMatchObject({ id, from: "agent-a", to: "agent-b", status: "ready" });

    const read = json(await callTool(b.client, "read_handoff", { id }));
    expect(read.meta.task).toBe("Review hello.txt");
    await expect(fs.stat(path.join(ws.root, p))).resolves.toBeTruthy();
  });

  it("cannot forge the sender: `from` always comes from the token", async () => {
    const h = await callTool(a.client, "write_handoff", {
      to: "agent-b",
      task: "forged?",
      status: "ready",
      from: "agent-b",
    });
    expect(h.isError).toBe(false);
    const read = json(await callTool(b.client, "read_handoff", { id: json(h).id }));
    expect(read.meta.from).toBe("agent-a");
  });

  it("rejects a handoff to an unknown agent", async () => {
    const h = await callTool(a.client, "write_handoff", { to: "agent-z", task: "x", status: "ready" });
    expect(h.isError).toBe(true);
  });

  it("blocks generic file tools from writing into .handoffs", async () => {
    const r = await callTool(a.client, "write_file", { path: ".handoffs/x.md", content: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Path not allowed/);
  });

  it("blocks a path traversal read", async () => {
    const r = await callTool(b.client, "read_file", { path: "../README.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Path not allowed/);
  });

  it("catches a stale-hash overwrite", async () => {
    const first = json(await callTool(a.client, "write_file", { path: "hello.txt", content: "hi" }));
    const ok = await callTool(a.client, "write_file", {
      path: "hello.txt",
      content: "v2",
      expected_sha256: first.sha256,
    });
    expect(ok.isError).toBe(false);

    const stale = await callTool(b.client, "write_file", {
      path: "hello.txt",
      content: "v3",
      expected_sha256: first.sha256,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/File changed since you read it/);
    expect(await fs.readFile(path.join(ws.root, "hello.txt"), "utf8")).toBe("v2");
  });

  it("refuses to overwrite an existing file without a hash", async () => {
    await callTool(a.client, "write_file", { path: "hello.txt", content: "hi" });
    const r = await callTool(b.client, "write_file", { path: "hello.txt", content: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expected_sha256 is required/);
  });

  it("rejects an oversize write and creates nothing", async () => {
    const r = await callTool(a.client, "write_file", { path: "big.txt", content: "x".repeat(1001) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/too large/i);
    await expect(fs.stat(path.join(ws.root, "big.txt"))).rejects.toThrow();
  });

  it("rejects binary content", async () => {
    const r = await callTool(a.client, "write_file", { path: "bin.dat", content: "a\0b" });
    expect(r.isError).toBe(true);
  });
});

describe("git tools over MCP", () => {
  it("commits show the right agent as author", async () => {
    await callTool(a.client, "write_file", { path: "a.txt", content: "one" });
    const ca = json(await callTool(a.client, "git_commit", { message: "add a" }));
    expect(ca.author).toBe("agent-a");

    await callTool(b.client, "write_file", { path: "b.txt", content: "two" });
    const cb = json(await callTool(b.client, "git_commit", { message: "add b" }));
    expect(cb.author).toBe("agent-b");

    const log = json(await callTool(a.client, "git_log", {}));
    expect(log.commits.map((c: { author: string }) => c.author)).toEqual(["agent-b", "agent-a"]);
  });

  it("returns an error for an empty commit and for a protected diff path", async () => {
    expect((await callTool(a.client, "git_commit", { message: "nothing" })).isError).toBe(true);
    expect((await callTool(a.client, "git_diff", { path: ".git/config" })).isError).toBe(true);
  });
});

describe("audit log over MCP", () => {
  it("records every call, blocked ones included, with the authenticated agent", async () => {
    await callTool(a.client, "write_file", { path: "ok.txt", content: "fine" });
    await callTool(b.client, "read_file", { path: "../../etc/passwd" });
    await callTool(a.client, "write_file", { path: "ok.txt", content: "again" }); // no hash: conflict

    const rows = await readAudit(ws);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ agent: "agent-a", tool: "write_file", path: "ok.txt", ok: true });
    expect(rows[1]).toMatchObject({
      agent: "agent-b",
      tool: "read_file",
      path: "../../etc/passwd",
      ok: false,
      error: "SandboxError",
    });
    expect(rows[2]).toMatchObject({ agent: "agent-a", ok: false, error: "ConflictError" });
    for (const r of rows) expect(typeof r.ms).toBe("number");
  });

  it("never logs file contents or tokens", async () => {
    await callTool(a.client, "write_file", { path: "s.txt", content: "TOP-SECRET-CONTENT" });
    await callTool(a.client, "write_handoff", {
      to: "agent-b",
      task: "t",
      status: "ready",
      next: ["PRIVATE-NOTE-TEXT"],
    });
    await ws.services.audit.flush();
    const raw = await fs.readFile(ws.auditPath, "utf8");
    expect(raw).not.toContain("TOP-SECRET-CONTENT");
    expect(raw).not.toContain("PRIVATE-NOTE-TEXT");
    expect(raw).not.toContain(TOKEN_A);
    expect(raw).not.toContain(TOKEN_B);
  });

  it("documents the known gap: schema-invalid calls never reach the audit log", async () => {
    const r = await callTool(a.client, "write_file", { content: "no path given" });
    expect(r.isError).toBe(true);
    expect(await readAudit(ws)).toEqual([]);
  });
});