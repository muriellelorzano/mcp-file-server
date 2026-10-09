import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, SandboxError } from "../../src/core/errors.js";
import { createSandbox, type Sandbox } from "../../src/core/sandbox.js";
import { canSymlink, makeWorkspace, type TestWorkspace } from "../helpers.js";

const symlinksOk = await canSymlink();

let ws: TestWorkspace;
let sb: Sandbox;

beforeEach(async () => {
  ws = await makeWorkspace();
  sb = createSandbox(ws.root);
  await fs.mkdir(path.join(ws.root, "src"));
  await fs.writeFile(path.join(ws.root, "src", "a.txt"), "hello");
});
afterEach(() => ws.cleanup());

describe("lexical escapes", () => {
  it.each([
    "../outside/secret.txt",
    "../../etc/passwd",
    "foo/../../x",
    "src/../../outside/secret.txt",
  ])("rejects traversal: %s", async (p) => {
    await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
  });

  it.each(["/etc/passwd", "C:\\Windows\\x", "C:/Windows/x", "\\\\server\\share"])(
    "rejects absolute path: %s",
    async (p) => {
      await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
    },
  );

  it("rejects null bytes", async () => {
    await expect(sb.resolveSafePath("a\0b")).rejects.toThrow(SandboxError);
  });

  it("rejects backslashes", async () => {
    await expect(sb.resolveSafePath("src\\..\\..\\x")).rejects.toThrow(SandboxError);
  });

  it("rejects empty and oversized paths", async () => {
    await expect(sb.resolveSafePath("")).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath("a".repeat(513))).rejects.toThrow(SandboxError);
  });

  it("rejects paths deeper than 12 segments", async () => {
    const deep = Array(13).fill("d").join("/") + "/f.txt";
    await expect(sb.resolveSafePath(deep)).rejects.toThrow(SandboxError);
  });

  it("treats encoded dots as literal names that stay inside", async () => {
    const p = await sb.resolveSafePath("%2e%2e/x");
    expect(p.startsWith(ws.root + path.sep)).toBe(true);
  });
});

describe("normalization", () => {
  it.each(["./src/./a.txt", "src//a.txt", "src/../src/a.txt"])("resolves %s inside root", async (p) => {
    const abs = await sb.resolveSafePath(p, { mustExist: true });
    expect(abs).toBe(path.join(ws.root, "src", "a.txt"));
  });
});

describe("protected locations", () => {
  it.each([".git/config", ".GIT/config", ".env", ".env.local", "node_modules/x", "src/.env"])(
    "rejects %s",
    async (p) => {
      await expect(sb.resolveSafePath(p)).rejects.toThrow(SandboxError);
    },
  );

  it("blocks writes under .handoffs but allows reads", async () => {
    await expect(sb.resolveSafePath(".handoffs/x.md", { write: true })).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath(".handoffs/x.md")).resolves.toBeTypeOf("string");
  });
});

describe("workspace root", () => {
  it("is rejected unless allowRoot is set", async () => {
    await expect(sb.resolveSafePath(".")).rejects.toThrow(SandboxError);
    await expect(sb.resolveSafePath(".", { allowRoot: true })).resolves.toBe(ws.root);
  });
});

describe.skipIf(!symlinksOk)("symlinks", () => {
  it("rejects a symlink to an outside directory", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"), "junction");
    await expect(sb.resolveSafePath("link/secret.txt", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a symlink to an outside file", async () => {
    await fs.symlink(path.join(ws.outside, "secret.txt"), path.join(ws.root, "s.txt"));
    await expect(sb.resolveSafePath("s.txt", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a NEW file under a symlinked parent that points outside", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"), "junction");
    await expect(sb.resolveSafePath("link/new.txt", { write: true })).rejects.toThrow(SandboxError);
  });

  it("rejects writing through a dangling symlink", async () => {
    await fs.symlink(path.join(ws.outside, "does-not-exist.txt"), path.join(ws.root, "dangling"));
    await expect(sb.resolveSafePath("dangling", { write: true })).rejects.toThrow(SandboxError);
  });

  it("rejects a symlink loop", async () => {
    await fs.symlink(path.join(ws.root, "b"), path.join(ws.root, "a"));
    await fs.symlink(path.join(ws.root, "a"), path.join(ws.root, "b"));
    await expect(sb.resolveSafePath("a", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("rejects an in-workspace symlink that points at .git", async () => {
    await fs.mkdir(path.join(ws.root, ".git"));
    await fs.writeFile(path.join(ws.root, ".git", "config"), "x");
    await fs.symlink(path.join(ws.root, ".git"), path.join(ws.root, "sneaky"), "junction");
    await expect(sb.resolveSafePath("sneaky/config", { mustExist: true })).rejects.toThrow(SandboxError);
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await fs.symlink(path.join(ws.root, "src"), path.join(ws.root, "alias"), "junction");
    const abs = await sb.resolveSafePath("alias/a.txt", { mustExist: true });
    expect(abs).toBe(path.join(ws.root, "src", "a.txt"));
  });
});

describe("existence", () => {
  it("throws NotFoundError when mustExist and missing", async () => {
    await expect(sb.resolveSafePath("nope.txt", { mustExist: true })).rejects.toThrow(NotFoundError);
  });

  it("allows a new file in a missing directory when not mustExist", async () => {
    const abs = await sb.resolveSafePath("new/dir/file.txt", { write: true });
    expect(abs).toBe(path.join(ws.root, "new", "dir", "file.txt"));
  });

  it("does not leak the host path in error messages", async () => {
    const err = await sb.resolveSafePath("../outside/secret.txt").catch((e: Error) => e);
    expect((err as Error).message).not.toContain(ws.base);
  });
});