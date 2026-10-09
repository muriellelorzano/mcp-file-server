import fs from "node:fs";
import path from "node:path";

export type AuditEntry = {
  agent: string;
  tool: string;
  ok: boolean;
  ms: number;
  error?: string;
  args?: Record<string, unknown>;
};

export type Audit = ReturnType<typeof createAudit>;

/** JSON Lines log. Never throws into the caller: a failed write goes to stderr. */
export function createAudit(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let chain: Promise<unknown> = Promise.resolve();

  function record(entry: AuditEntry): void {
    const { args, ...rest } = entry;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...args, ...rest }) + "\n";
    chain = chain
      .then(() => fs.promises.appendFile(filePath, line, "utf8"))
      .catch((err: Error) => console.error("[audit] write failed:", err.message));
  }

  /** Resolves when every queued record is on disk (tests, shutdown). */
  async function flush(): Promise<void> {
    await chain;
  }

  return { record, flush, path: filePath };
}