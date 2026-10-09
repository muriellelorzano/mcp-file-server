import type { Config } from "../config.js";
import { createAudit } from "./audit.js";
import { createFsOps } from "./fsOps.js";
import { createGitRunner } from "./gitRunner.js";
import { createHandoffStore } from "./handoffStore.js";
import { createLocks } from "./locks.js";
import { createSandbox } from "./sandbox.js";

export type Services = ReturnType<typeof createServices>;

export function createServices(cfg: Config) {
  const sandbox = createSandbox(cfg.workspaceRoot);
  const locks = createLocks(cfg.limits.lockTimeoutMs);
  const fs = createFsOps(sandbox, locks, cfg.limits);
  const handoff = createHandoffStore({
    sandbox,
    limits: cfg.limits,
    knownAgents: new Set(cfg.agentTokens.values()),
  });
  const git = createGitRunner({ sandbox, locks, limits: cfg.limits });
  const audit = createAudit(cfg.auditPath);
  return { fs, handoff, git, audit };
}