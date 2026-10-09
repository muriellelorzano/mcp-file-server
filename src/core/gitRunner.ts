import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Limits } from "../config.js";
import { ConflictError, GitError } from "./errors.js";
import type { Locks } from "./locks.js";
import type { Sandbox } from "./sandbox.js";

const execFileAsync = promisify(execFile);

const REPO_LOCK = "git:repo";
const MAX_BUFFER = 5 * 1024 * 1024;
const ENV_ALLOWLIST = [
  "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT",
];
const EXCLUDES = [".env", ".env.*", "node_modules/", "*.tmp"];
const STATUS_LABEL: Record<string, string> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "typechange",
};

export type GitRunner = ReturnType<typeof createGitRunner>;

type RunOpts = { okCodes?: number[]; ignoreFailure?: boolean };
type RunResult = { stdout: string; stderr: string; code: number };

export function createGitRunner(deps: { sandbox: Sandbox; locks: Locks; limits: Limits }) {
  const { sandbox, locks, limits } = deps;
  const root = sandbox.root;

  const env: NodeJS.ProcessEnv = (() => {
    const e: NodeJS.ProcessEnv = {};
    const seen = new Set<string>();
    for (const k of ENV_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined && !seen.has(k.toLowerCase())) {
        e[k] = v;
        seen.add(k.toLowerCase());
      }
    }
    return {
      ...e,
      GIT_DIR: path.join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    };
  })();

  const scrub = (s: string) =>
    s.split(root).join("<workspace>").split(root.replace(/\\/g, "/")).join("<workspace>").trim().slice(0, 300);

  async function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
    const full = [
      "-c", "core.quotepath=false",
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "core.fsmonitor=false",
      ...args,
    ];
    try {
      const { stdout, stderr } = await execFileAsync("git", full, {
        cwd: root,
        env,
        timeout: limits.gitTimeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { code?: string | number; killed?: boolean; stdout?: string; stderr?: string };
      if (e.code === "ENOENT") throw new GitError("git is not installed or not on PATH");
      if (e.killed) throw new GitError("git timed out");
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new GitError("git output too large");
      if (typeof e.code === "number") {
        if (opts.ignoreFailure || opts.okCodes?.includes(e.code)) {
          return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
        }
        throw new GitError(scrub(e.stderr || e.stdout || `git exited with code ${e.code}`));
      }
      throw new GitError("git failed to run");
    }
  }

  async function pathspec(rel: string): Promise<string> {
    const abs = await sandbox.resolveSafePath(rel, { allowRoot: true });
    return sandbox.toRelative(abs);
  }

  /** Keep protected files out of commits even if the host operator drops them in the workspace. */
  async function ensureExcludes() {
    const file = path.join(root, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, "utf8").catch(() => "");
    const have = new Set(current.split(/\r?\n/));
    const missing = EXCLUDES.filter((l) => !have.has(l));
    if (missing.length > 0) {
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      await fs.appendFile(file, `${sep}${missing.join("\n")}\n`);
    }
  }

  async function ensureRepo() {
    const exists = await fs.stat(path.join(root, ".git")).then(() => true, () => false);
    if (!exists) {
      await run(["init"]);
      await run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    await ensureExcludes();
    return { created: !exists };
  }

  function parseBranch(s: string): string {
    const unborn = /^No commits yet on (.+)$/.exec(s);
    return unborn ? unborn[1]! : s.split("...")[0]!;
  }

  async function status() {
    const { stdout } = await run(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
    const records = stdout.split("\0").filter(Boolean);
    let branch = "unknown";
    const changed: { path: string; status: string }[] = [];
    let truncated = false;

    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (rec.startsWith("## ")) {
        branch = parseBranch(rec.slice(3));
        continue;
      }
      const xy = rec.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C") i++; // -z puts the old name in the next record
      if (changed.length >= limits.maxListEntries) {
        truncated = true;
        continue;
      }
      const code = xy === "??" ? "untracked" : STATUS_LABEL[xy[0] !== " " ? xy[0]! : xy[1]!] ?? "changed";
      changed.push({ path: rec.slice(3), status: code });
    }
    return { branch, changed, truncated };
  }

  async function diff(rel?: string, staged = false) {
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if (staged) args.push("--cached");
    if (rel) args.push("--", await pathspec(rel));
    const { stdout } = await run(args);
    return stdout.length > limits.maxDiffBytes
      ? { diff: stdout.slice(0, limits.maxDiffBytes), truncated: true }
      : { diff: stdout, truncated: false };
  }

  async function commit(agentId: string, message: string, rels: string[] = []) {
    const msg = message.trim();
    if (!msg || msg.includes("\0")) throw new GitError("Commit message is empty or invalid");

    const specs: string[] = [];
    for (const r of rels) specs.push(await pathspec(r));
    const scope = specs.length > 0 ? ["--", ...specs] : [];
    const ident = [
      "-c", `user.name=${agentId}`,
      "-c", `user.email=${agentId}@workspace.local`,
      "-c", "commit.gpgsign=false",
    ];

    // one writer at a time; the index is rebuilt per commit so agents never commit each other's staged files
    return locks.withLock(REPO_LOCK, async () => {
      await run(["reset", "-q"], { ignoreFailure: true });
      await run(["add", "-A", ...scope]);

      const staged = await run(["diff", "--cached", "--name-only", "-z"]);
      const files = staged.stdout.split("\0").filter(Boolean);
      if (files.length === 0) throw new ConflictError("Nothing to commit");

      await run([
        ...ident, "commit", "--no-verify", "-m", msg,
        "--author", `${agentId} <${agentId}@workspace.local>`,
      ]);
      const head = await run(["rev-parse", "--short", "HEAD"]);
      return { commit: head.stdout.trim(), author: agentId, files_changed: files.length, files: files.slice(0, 50) };
    });
  }

  async function log(limit = 20, rel?: string) {
    const args = ["log", "--no-color", `-n${Math.min(limit, 50)}`, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e"];
    if (rel) args.push("--", await pathspec(rel));
    const res = await run(args, { okCodes: [128] });

    if (res.code === 128) {
      if (/does not have any commits yet/i.test(res.stderr)) return { commits: [] };
      throw new GitError(scrub(res.stderr || "git log failed"));
    }
    const commits = res.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash = "", author = "", date = "", subject = ""] = rec.split("\x1f");
        return { hash: hash.slice(0, 12), author, date, subject };
      });
    return { commits };
  }

  return { ensureRepo, status, diff, commit, log };
}