import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudit } from "../../src/core/audit.js";

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const lines = async (file: string) =>
  (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("audit log", () => {
  it("writes one JSON line per record with a timestamp", async () => {
    const file = path.join(base, "logs", "audit.jsonl"); // directory is created for us
    const audit = createAudit(file);
    audit.record({ agent: "agent-a", tool: "read_file", ok: true, ms: 3, args: { path: "a.txt" } });
    audit.record({ agent: "agent-b", tool: "read_file", ok: false, ms: 1, error: "SandboxError", args: { path: "../x" } });
    await audit.flush();

    const rows = await lines(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agent: "agent-a", tool: "read_file", ok: true, ms: 3, path: "a.txt" });
    expect(typeof rows[0].ts).toBe("string");
    expect(Number.isNaN(Date.parse(rows[0].ts))).toBe(false);
    expect(rows[1]).toMatchObject({ ok: false, error: "SandboxError", path: "../x" });
  });

  it("keeps records in the order they were made", async () => {
    const file = path.join(base, "audit.jsonl");
    const audit = createAudit(file);
    for (let i = 0; i < 50; i++) audit.record({ agent: "agent-a", tool: "t", ok: true, ms: i });
    await audit.flush();
    expect((await lines(file)).map((r) => r.ms)).toEqual([...Array(50).keys()]);
  });

  it("appends to an existing log instead of replacing it", async () => {
    const file = path.join(base, "audit.jsonl");
    const one = createAudit(file);
    one.record({ agent: "agent-a", tool: "t", ok: true, ms: 1 });
    await one.flush();
    const two = createAudit(file);
    two.record({ agent: "agent-a", tool: "t", ok: true, ms: 2 });
    await two.flush();
    expect(await lines(file)).toHaveLength(2);
  });

  it("never throws when the log cannot be written; it reports on stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const audit = createAudit(base); // a directory, so appendFile fails
    expect(() => audit.record({ agent: "agent-a", tool: "t", ok: true, ms: 1 })).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});