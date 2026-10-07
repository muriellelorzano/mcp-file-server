import path from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  MAX_LIST_ENTRIES: z.coerce.number().int().min(1).default(500),
});

export type Config = Readonly<{
  port: number;
  workspaceRoot: string;
  limits: Readonly<{ maxListEntries: number }>;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return Object.freeze({
    port: e.PORT,
    workspaceRoot: path.resolve(e.WORKSPACE_ROOT),
    limits: Object.freeze({ maxListEntries: e.MAX_LIST_ENTRIES }),
  });
}

