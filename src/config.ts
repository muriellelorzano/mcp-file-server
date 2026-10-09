import path from "node:path";
import { z } from "zod";

const AGENT_ID = /^[a-z0-9-]{1,32}$/;
const MIN_TOKEN_LENGTH = 32;

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  MAX_LIST_ENTRIES: z.coerce.number().int().min(1).default(500),
  MAX_FILE_BYTES: z.coerce.number().int().min(1).default(262_144),
  MAX_READ_BYTES: z.coerce.number().int().min(1).default(524_288),
  MAX_SEARCH_FILES: z.coerce.number().int().min(1).default(2000),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(3000),
  AGENT_TOKENS: z.string().min(1, "AGENT_TOKENS is required"),
  AUDIT_PATH: z.string().min(1).default("./logs/audit.jsonl"),
  MAX_DIFF_BYTES: z.coerce.number().int().min(1).default(100_000),
  GIT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});

export type Limits = Readonly<{
  maxListEntries: number;
  maxFileBytes: number;
  maxReadBytes: number;
  maxSearchFiles: number;
  lockTimeoutMs: number;
  maxDiffBytes: number;
  gitTimeoutMs: number;
}>;

export type Config = Readonly<{
  port: number;
  workspaceRoot: string;
  limits: Limits;
  /** token -> agentId */
  agentTokens: ReadonlyMap<string, string>;
  auditPath: string;
}>;

/** Parses "token:agent-a,token:agent-b". Error messages never echo token values. */
export function parseAgentTokens(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const seenAgents = new Set<string>();

  for (const [i, part] of raw.split(",").entries()) {
    const entry = part.trim();
    if (!entry) continue;

    const idx = entry.indexOf(":");
    if (idx === -1) throw new Error(`AGENT_TOKENS entry ${i + 1} must look like token:agent-id`);

    const token = entry.slice(0, idx);
    const agent = entry.slice(idx + 1);

    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`AGENT_TOKENS entry ${i + 1}: token must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
      throw new Error(`AGENT_TOKENS entry ${i + 1}: token has invalid characters`);
    }
    if (!AGENT_ID.test(agent)) {
      throw new Error(`AGENT_TOKENS entry ${i + 1}: agent id must match ${AGENT_ID}`);
    }
    if (map.has(token)) throw new Error(`AGENT_TOKENS entry ${i + 1}: duplicate token`);
    if (seenAgents.has(agent)) throw new Error(`AGENT_TOKENS entry ${i + 1}: duplicate agent id "${agent}"`);

    map.set(token, agent);
    seenAgents.add(agent);
  }

  if (map.size === 0) throw new Error("AGENT_TOKENS contains no valid entries");
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return Object.freeze({
    port: e.PORT,
    workspaceRoot: path.resolve(e.WORKSPACE_ROOT),
    limits: Object.freeze({
      maxListEntries: e.MAX_LIST_ENTRIES,
      maxFileBytes: e.MAX_FILE_BYTES,
      maxReadBytes: e.MAX_READ_BYTES,
      maxSearchFiles: e.MAX_SEARCH_FILES,
      lockTimeoutMs: e.LOCK_TIMEOUT_MS,
      maxDiffBytes: e.MAX_DIFF_BYTES,
      gitTimeoutMs: e.GIT_TIMEOUT_MS,
    }),
    agentTokens: parseAgentTokens(e.AGENT_TOKENS),
    auditPath: path.resolve(e.AUDIT_PATH),
  });
}