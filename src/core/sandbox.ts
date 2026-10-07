import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { NotFoundError, SandboxError } from "./errors.js";

const MAX_PATH_LENGTH = 512;
const MAX_DEPTH = 12;
const HANDOFF_DIR = ".handoffs";

// case-insensitive so ".GIT" is blocked on case-insensitive filesystems
const isDenied = (seg: string): boolean => {
  const s = seg.toLowerCase();
  return s === ".git" || s === ".env" || s.startsWith(".env.") || s === "node_modules";
};

export type ResolveOpts = {
  /** Target must already exist (reads, edits, deletes). */
  mustExist?: boolean;
  /** Operation modifies the workspace. Blocks .handoffs/ (handoff tools only). */
  write?: boolean;
  /** Allow the workspace root itself (listing, searching). */
  allowRoot?: boolean;
};

export type Sandbox = ReturnType<typeof createSandbox>;

export function createSandbox(rootInput: string) {
  // canonical root, computed once
  const root = realpathSync(path.resolve(rootInput));
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);
  const segmentsOf = (abs: string) => path.relative(root, abs).split(path.sep).filter(Boolean);

  function checkSegments(segs: string[], opts: ResolveOpts) {
    if (segs.some(isDenied)) {
      throw new SandboxError("Path not allowed: protected location");
    }
    if (opts.write && segs[0] === HANDOFF_DIR) {
      throw new SandboxError("Path not allowed: .handoffs is managed by handoff tools");
    }
  }

  async function resolveSafePath(rel: string, opts: ResolveOpts = {}): Promise<string> {
    // 1. shape checks
    if (typeof rel !== "string" || rel.length === 0 || rel.length > MAX_PATH_LENGTH) {
      throw new SandboxError("Path not allowed: invalid path");
    }
    if (rel.includes("\0")) {
      throw new SandboxError("Path not allowed: null byte");
    }
    if (rel.includes("\\")) {
      throw new SandboxError("Path not allowed: backslashes are rejected");
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new SandboxError("Path not allowed: absolute paths are rejected");
    }

    // 2. lexical containment
    const candidate = path.resolve(root, rel);
    if (!inside(candidate)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }

    const segs = segmentsOf(candidate);
    if (segs.length === 0 && !opts.allowRoot) {
      throw new SandboxError("Path not allowed: workspace root");
    }
    if (segs.length > MAX_DEPTH) {
      throw new SandboxError("Path not allowed: too deep");
    }
    checkSegments(segs, opts);

    // 3. symlink resolution: find the deepest existing ancestor and realpath it
    let probe = candidate;
    const tail: string[] = [];
    let base: string;
    for (;;) {
      try {
        base = await fs.realpath(probe);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw new SandboxError("Path not allowed: symlink loop");
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;

        // entry exists but realpath failed => dangling symlink; never write through it
        const entry = await fs.lstat(probe).catch(() => null);
        if (entry) throw new SandboxError("Path not allowed: dangling symlink");

        tail.unshift(path.basename(probe));
        const up = path.dirname(probe);
        if (up === probe) throw new NotFoundError(`Not found: ${rel}`);
        probe = up;
      }
    }

    if (opts.mustExist && tail.length > 0) {
      throw new NotFoundError(`Not found: ${rel}`);
    }

    // 4. re-check everything on the resolved path (defeats symlinks)
    const real = path.join(base, ...tail);
    if (!inside(real)) {
      throw new SandboxError("Path not allowed: escapes workspace");
    }
    const realSegs = segmentsOf(real);
    if (realSegs.length === 0 && !opts.allowRoot) {
      throw new SandboxError("Path not allowed: workspace root");
    }
    checkSegments(realSegs, opts);

    return real;
  }

  function toRelative(abs: string): string {
    const rel = path.relative(root, abs);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  return { root, resolveSafePath, toRelative, isDenied };
}

