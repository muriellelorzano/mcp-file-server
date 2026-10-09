import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/transport/app.js";
import { createAuthenticator } from "../../src/transport/auth.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
let server: Server;
let url: string;

const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const baseHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

beforeAll(async () => {
  ws = await makeWorkspace();
  const app = createApp(ws.services, createAuthenticator(ws.config.agentTokens));
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await ws.cleanup();
});

const post = (headers: Record<string, string> = {}) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: { ...baseHeaders, ...headers },
    body: JSON.stringify(rpc),
  });

describe("health", () => {
  it("is public and reveals nothing else", async () => {
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("auth on /mcp", () => {
  it("rejects a request with no token", async () => {
    const r = await post();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token", async () => {
    expect((await post({ authorization: `Bearer ${"z".repeat(40)}` })).status).toBe(401);
  });

  it("rejects the wrong scheme", async () => {
    expect((await post({ authorization: `Basic ${TOKEN_A}` })).status).toBe(401);
  });

  it("rejects GET and DELETE without a token (no 405 leak)", async () => {
    expect((await fetch(`${url}/mcp`)).status).toBe(401);
    expect((await fetch(`${url}/mcp`, { method: "DELETE" })).status).toBe(401);
  });

  it("accepts a valid token and lists the tools", async () => {
    const r = await post({ authorization: `Bearer ${TOKEN_A}` });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("list_files");
  });

  it("accepts the second agent's token too", async () => {
    expect((await post({ authorization: `Bearer ${TOKEN_B}` })).status).toBe(200);
  });

  it("does not leak the token in the 401 body", async () => {
    const bad = `Bearer ${"q".repeat(40)}`;
    const text = await (await post({ authorization: bad })).text();
    expect(text).not.toContain("q".repeat(40));
  });
});