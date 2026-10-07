import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/core/services.js";

/**
 * Layout:  <base>/workspace   <- the sandbox root
 *          <base>/outside     <- a sibling the sandbox must never reach
 */
export async function makeWorkspace(overrides: Record<string, string> = {}) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mcpws-")),
  );
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");

  const config = loadConfig({
  WORKSPACE_ROOT: root,
  AGENT_TOKENS: `${"a".repeat(40)}:agent-a,${"b".repeat(40)}:agent-b`,
  ...overrides,
} as NodeJS.ProcessEnv);

  return {
    base,
    root,
    outside,
    config,
    services,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

export type TestWorkspace = Awaited<ReturnType<typeof makeWorkspace>>;
