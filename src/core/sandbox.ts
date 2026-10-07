import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { NotFoundError, SandboxError } from "./errors.js";

const DENIED = (seg: string) =>
  seg === ".git" || seg === ".env" || seg.startsWith(".env.") || seg === "node_modules";

export type Sandbox = ReturnType<typeof createSandbox>;

export function createSandbox(rootInput: string) {
  // realpath once so every later comparison uses the same canonical root
  const root = realpathSync(path.resolve(rootInput));

  const inside = (p: string) => p === root || p.startsWith(root + path.sep);

  async function resolveSafePath(
    rel: string,
    opts: { mustExist?: boolean } = {},
  ): Promise<string> {
    if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) {
      throw new SandboxError("Invalid path input");
    }

    // block absolute paths
    if (path.isAbsolute(rel)) {
      throw new SandboxError("Absolute paths not allowed");
    }

    // block parent references at the segment level to prevent bypass via tricks
    const segments = rel.split(/[/\\]/).filter((s) => s.length > 0);
    if (segments.some((seg) => seg === ".." || DENIED(seg))) {
      throw new SandboxError("Path not allowed");
    }

    const candidate = path.join(root, rel);
    if (!inside(candidate)) {
      throw new SandboxError("Path escapes sandbox");
    }

    if (opts.mustExist) {
      try {
        await fs.access(candidate);
      } catch {
        throw new NotFoundError(`Not found: ${rel}`);
      }
    }

    return candidate;
  }

  return Object.freeze({ root, resolveSafePath });
}

