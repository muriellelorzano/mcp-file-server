import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafe, toRel, assertWritable, SandboxError, MAX_WRITE_BYTES } from "./sandbox.js";

const execFileP = promisify(execFile);

export const HANDOFF_FILES = ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"] as const;
export type HandoffLog = "PLAN_LOG" | "CHECKPOINTS" | "DECISIONS";

const MAX_READ_BYTES = 1_000_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export class Ops {
  readonly root: string;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }

  /** Create handoff files and git repo on first boot. Idempotent. */
  async init(): Promise<void> {
    const seeds: Record<string, string> = {
      "PROJECT_STATE.md":
        "# PROJECT_STATE\n\n_Current truth about the project. Overwrite freely; keep it short._\n\n- Goal: (not set)\n- Status: not started\n- Next step: (not set)\n",
      "PLAN_LOG.md": "# PLAN_LOG\n\n_Append-only. One entry per plan or plan change._\n",
      "CHECKPOINTS.md": "# CHECKPOINTS\n\n_Append-only. What is done and verified, so the next session can resume._\n",
      "DECISIONS.md": "# DECISIONS\n\n_Append-only. Decisions and the reasons for them._\n",
    };
    for (const [name, body] of Object.entries(seeds)) {
      const p = path.join(this.root, name);
      if (!fs.existsSync(p)) fs.writeFileSync(p, body);
    }
    if (!fs.existsSync(path.join(this.root, ".git"))) {
      await this.git(["init", "-q", "-b", "main"]);
      await this.git(["config", "user.name", "mcp-agent"]);
      await this.git(["config", "user.email", "agent@mcp.local"]);
      await this.git(["add", "-A"]);
      await this.git(["commit", "-q", "-m", "Initial handoff files"]);
    }
  }

  private async git(args: string[]): Promise<string> {
    // execFile (no shell) => arguments can't be shell-injected.
    const { stdout } = await execFileP("git", args, { cwd: this.root, maxBuffer: 5_000_000 });
    return stdout;
  }

  // ---------- file ops ----------
  listFiles(dir = ".", recursive = false): string[] {
    const abs = resolveSafe(this.root, dir);
    if (!fs.statSync(abs).isDirectory()) throw new SandboxError(`Not a directory: ${dir}`);
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(d, e.name);
        const rel = toRel(this.root, full);
        out.push(e.isDirectory() ? rel + "/" : rel);
        if (recursive && e.isDirectory() && !e.isSymbolicLink()) walk(full);
      }
    };
    walk(abs);
    return out;
  }

  readFile(p: string): { content: string; version: string } {
    const abs = resolveSafe(this.root, p);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new SandboxError(`Not a file: ${p}`);
    if (st.size > MAX_READ_BYTES) throw new SandboxError(`File too large to read (${st.size} bytes)`);
    const content = fs.readFileSync(abs, "utf8");
    return { content, version: sha(content) };
  }

  /** if_version = optimistic locking. Pass the version from your last read; a mismatch refuses the write. */
  writeFile(p: string, content: string, ifVersion?: string): { path: string; version: string; bytes: number } {
    const abs = resolveSafe(this.root, p);
    const bytes = Buffer.byteLength(content);
    assertWritable(this.root, abs, bytes);
    if (ifVersion !== undefined) {
      const current = fs.existsSync(abs) ? sha(fs.readFileSync(abs)) : "absent";
      if (current !== ifVersion) {
        throw new SandboxError(`Version conflict: file is at ${current}, you sent ${ifVersion}. Re-read and retry.`);
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { path: toRel(this.root, abs), version: sha(content), bytes };
  }

  strReplace(p: string, oldStr: string, newStr: string, ifVersion?: string) {
    const abs = resolveSafe(this.root, p);
    assertWritable(this.root, abs);
    if (!fs.existsSync(abs)) throw new SandboxError(`File not found: ${p}`);
    const current = fs.readFileSync(abs, "utf8");
    if (ifVersion !== undefined && sha(current) !== ifVersion) {
      throw new SandboxError(`Version conflict: file is at ${sha(current)}, you sent ${ifVersion}. Re-read and retry.`);
    }
    if (oldStr === "") throw new SandboxError("old_str must not be empty");
    const count = current.split(oldStr).length - 1;
    if (count === 0) throw new SandboxError("old_str not found in file");
    if (count > 1) throw new SandboxError(`old_str matches ${count} places; make it unique`);
    const next = current.replace(oldStr, () => newStr); // fn avoids $-pattern surprises
    assertWritable(this.root, abs, Buffer.byteLength(next));
    fs.writeFileSync(abs, next);
    return { path: toRel(this.root, abs), version: sha(next) };
  }

  deleteFile(p: string): { deleted: string } {
    const abs = resolveSafe(this.root, p);
    assertWritable(this.root, abs);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) throw new SandboxError("Refusing to delete a directory; delete files individually");
    if (path.basename(abs) === "PROJECT_STATE.md" && path.dirname(abs) === this.root) {
      throw new SandboxError("PROJECT_STATE.md is part of the handoff protocol and cannot be deleted");
    }
    fs.unlinkSync(abs);
    return { deleted: toRel(this.root, abs) };
  }

  searchFiles(query: string, dir = ".", maxResults = 50): { file: string; line: number; text: string }[] {
    if (!query) throw new SandboxError("query must not be empty");
    const base = resolveSafe(this.root, dir);
    const hits: { file: string; line: number; text: string }[] = [];
    const needle = query.toLowerCase();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (hits.length >= maxResults) return;
        if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (fs.statSync(full).size > MAX_READ_BYTES) continue;
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue; // skip binaries
        buf.toString("utf8").split("\n").forEach((line, i) => {
          if (hits.length < maxResults && line.toLowerCase().includes(needle)) {
            hits.push({ file: toRel(this.root, full), line: i + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
    };
    walk(base);
    return hits;
  }

  // ---------- handoff protocol ----------
  handoffRead(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of HANDOFF_FILES) out[f] = fs.readFileSync(path.join(this.root, f), "utf8");
    return out;
  }

  handoffAppend(log: HandoffLog, entry: string, author = "agent"): { file: string; appended: string } {
    if (!entry.trim()) throw new SandboxError("entry must not be empty");
    const file = `${log}.md`;
    const stamp = new Date().toISOString();
    const block = `\n## ${stamp} — ${author}\n${entry.trim()}\n`;
    const abs = path.join(this.root, file);
    if (fs.statSync(abs).size + Buffer.byteLength(block) > MAX_WRITE_BYTES) {
      throw new SandboxError(`${file} is full`);
    }
    fs.appendFileSync(abs, block);
    return { file, appended: stamp };
  }

  // ---------- git-lite ----------
  async gitStatus() { return (await this.git(["status", "--short", "--branch"])).trim() || "clean"; }
  async gitDiff(p?: string) {
    const args = ["diff", "HEAD", "--stat", "-p"];
    if (p) args.push("--", toRel(this.root, resolveSafe(this.root, p)));
    return (await this.git(args)).slice(0, 20_000) || "no changes";
  }
  async gitLog(n = 10) {
    return (await this.git(["log", `-n${Math.min(Math.max(n, 1), 50)}`, "--pretty=format:%h %ad %s", "--date=short"])).trim();
  }
  async gitCommit(message: string) {
    if (!message.trim()) throw new SandboxError("commit message must not be empty");
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    if (!status.trim()) return "nothing to commit";
    await this.git(["commit", "-q", "-m", message.slice(0, 200)]);
    return (await this.git(["log", "-1", "--pretty=format:%h %s"])).trim();
  }
}
