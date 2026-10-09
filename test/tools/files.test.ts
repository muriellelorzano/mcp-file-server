import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/transport/createServer.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
let client: Client;
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  close = undefined;
  ws = await makeWorkspace();
  const server = createServer({ agentId: "test-agent", services: ws.services });
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  close = async () => {
    await client.close();
    await server.close();
  };
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await close?.();
  await ws?.cleanup();
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
});

describe("happy path", () => {
  it("write -> read -> overwrite with hash -> list", async () => {
    const w = await call("write_file", { path: "notes/a.md", content: "v1" });
    expect(w.isError).toBe(false);

    const r = await call("read_file", { path: "notes/a.md" });
    const { sha256 } = JSON.parse(r.text);

    const w2 = await call("write_file", {
      path: "notes/a.md",
      content: "v2",
      expected_sha256: sha256,
    });
    expect(w2.isError).toBe(false);

    const l = await call("list_files", { recursive: true });
    expect(
      JSON.parse(l.text).entries.map((e: { path: string }) => e.path),
    ).toEqual(["notes", "notes/a.md"]);
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
    const r = await call("write_file", {
      path: "a.txt",
      content: "v2",
      expected_sha256: stale,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("current sha256");
  });

  it("rejects malformed input via zod", async () => {
    expect((await call("write_file", { path: "a.txt" })).isError).toBe(true); // missing content
    expect(
      (await call("read_file", { path: "a.txt", offset: -1 })).isError,
    ).toBe(true);
    expect(
      (await call("delete_file", { path: "a.txt", expected_sha256: "nothex" }))
        .isError,
    ).toBe(true);
    expect((await call("search_files", { query: "" })).isError).toBe(true);
  });
});
