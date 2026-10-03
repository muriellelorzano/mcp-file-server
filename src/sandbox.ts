import fs from "node:fs";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Is `child` equal to or inside `parent`? Uses path.relative so "/ws-evil" is not "inside" "/ws". */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied relative path against the workspace root.
 * Rejects: non-strings, empty/NUL-containing paths, absolute paths,
 * ".." escapes, and symlink escapes (checked on the deepest existing ancestor).
 * Returns the absolute path that is safe to use.
 */
export function resolveSafe(root: string, userPath: string): string {
  if (typeof userPath !== "string") throw new SandboxError("Path must be a string");
  if (userPath.includes("\0")) throw new SandboxError("Path contains a NUL byte");
  if (path.isAbsolute(userPath) || /^[A-Za-z]:[\\/]/.test(userPath)) {
    throw new SandboxError("Absolute paths are not allowed; use a path relative to the workspace");
  }

  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, userPath);
  if (!isInside(realRoot, target)) {
    throw new SandboxError(`Path escapes the workspace: ${userPath}`);
  }

  // Symlink defense: realpath the deepest ancestor that exists.
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (!isInside(realRoot, realProbe)) {
    throw new SandboxError(`Path escapes the workspace via symlink: ${userPath}`);
  }
  return target;
}

/** Display path (POSIX style, relative to root). */
export function toRel(root: string, abs: string): string {
  return path.relative(fs.realpathSync(root), abs).split(path.sep).join("/") || ".";
}

const PROTECTED_SEGMENTS = new Set([".git"]);
/** Handoff logs that may only be changed through handoff_append. */
export const APPEND_ONLY = new Set(["PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]);
export const MAX_WRITE_BYTES = 1_000_000; // 1 MB

/** Guards against bad writes. Throws SandboxError if the write must be refused. */
export function assertWritable(root: string, abs: string, newSizeBytes?: number): void {
  const rel = toRel(root, abs);
  if (rel === ".") throw new SandboxError("Cannot modify the workspace root itself");
  const parts = rel.split("/");
  if (parts.some((p) => PROTECTED_SEGMENTS.has(p))) {
    throw new SandboxError("The .git directory is protected; use the git_* tools");
  }
  if (parts.length === 1 && APPEND_ONLY.has(parts[0])) {
    throw new SandboxError(`${parts[0]} is append-only; use the handoff_append tool`);
  }
  if (newSizeBytes !== undefined && newSizeBytes > MAX_WRITE_BYTES) {
    throw new SandboxError(`Write of ${newSizeBytes} bytes exceeds the ${MAX_WRITE_BYTES}-byte limit`);
  }
}
