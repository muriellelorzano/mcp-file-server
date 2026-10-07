import type { Config } from "../config.js";
import { createFsOps } from "./fsOps.js";
import { createLocks } from "./locks.js";
import { createSandbox } from "./sandbox.js";

export type Services = ReturnType<typeof createServices>;

export function createServices(cfg: Config) {
  const sandbox = createSandbox(cfg.workspaceRoot);
  const locks = createLocks(cfg.limits.lockTimeoutMs);
  const fs = createFsOps(sandbox, locks, cfg.limits);
  return { fs };
}

