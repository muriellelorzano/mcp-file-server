import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/core/services.js";
import { createServer } from "../src/transport/createServer.js";

export const TOKEN_A = "a".repeat(40);
export const TOKEN_B = "b".repeat(40);

/**
 * Layout:  <base>/workspace   <- the sandbox root
 *          <base>/outside     <- a sibling the sandbox must never reach
 *          <base>/audit.jsonl <- audit log for this test
 */
export async function makeWorkspace(overrides: Record<string, string> = {}) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mcpws-")),
  );
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const auditPath = path.join(base, "audit.jsonl");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");

  const config = loadConfig({
    WORKSPACE_ROOT: root,
    AUDIT_PATH: auditPath,
    AGENT_TOKENS: `${TOKEN_A}:agent-a,${TOKEN_B}:agent-b`,
    ...overrides,
  } as NodeJS.ProcessEnv);
  const services = createServices(config);

  return {
    base,
    root,
    outside,
    auditPath,
    config,
    services,
    cleanup: async () => {
      await services.audit.flush();
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}

export type TestWorkspace = Awaited<ReturnType<typeof makeWorkspace>>;

/** True if this machine lets us create symlinks (Windows needs Developer Mode or admin). */
export async function canSymlink(): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symprobe-"));
  try {
    await fs.symlink(dir, path.join(dir, "probe"));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Connects an in-memory MCP client acting as the given agent. */
export async function connectAgent(ws: TestWorkspace, agentId: string) {
  const server = createServer({ agentId, services: ws.services });
  const client = new Client({ name: `test-${agentId}`, version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Calls a tool; protocol-level schema failures and tool errors both come back as isError. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: Boolean(r.isError), text };
  } catch (err) {
    return { isError: true, text: String(err) };
  }
}

export async function readAudit(
  ws: TestWorkspace,
): Promise<Array<Record<string, unknown>>> {
  await ws.services.audit.flush();
  const text = await fs.readFile(ws.auditPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
