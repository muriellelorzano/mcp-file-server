import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  InvalidContentError,
  TooLargeError,
} from "../../src/core/errors.js";
import { sha256Of } from "../../src/core/guards.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace({ MAX_FILE_BYTES: "100" });
});
afterEach(() => ws.cleanup());

const fsOps = () => ws.services.fs;

describe("write_file guards", () => {
  it("creates a new file and returns its hash", async () => {
    const r = await fsOps().write("a.txt", "hello");
    expect(r).toMatchObject({
      path: "a.txt",
      created: true,
      size: 5,
      sha256: sha256Of("hello"),
    });
  });

  it("creates parent directories", async () => {
    await fsOps().write("x/y/z.txt", "deep");
    expect(await fs.readFile(path.join(ws.root, "x/y/z.txt"), "utf8")).toBe(
      "deep",
    );
  });

  it("rejects overwrite without expected_sha256", async () => {
    await fsOps().write("a.txt", "v1");
    await expect(fsOps().write("a.txt", "v2")).rejects.toThrow(ConflictError);
  });

  it("rejects overwrite with a stale hash and reports the current one", async () => {
    const v1 = await fsOps().write("a.txt", "v1");
    await fsOps().write("a.txt", "v2", { expectedSha256: v1.sha256 });
    const err = await fsOps()
      .write("a.txt", "v3", { expectedSha256: v1.sha256 })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain(sha256Of("v2"));
    expect(await fs.readFile(path.join(ws.root, "a.txt"), "utf8")).toBe("v2");
  });

  it("accepts overwrite with the right hash", async () => {
    const v1 = await fsOps().write("a.txt", "v1");
    const v2 = await fsOps().write("a.txt", "v2", {
      expectedSha256: v1.sha256,
    });
    expect(v2.created).toBe(false);
  });

  it("rejects create_only on an existing file", async () => {
    await fsOps().write("a.txt", "v1");
    await expect(
      fsOps().write("a.txt", "v2", { createOnly: true }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects expected_sha256 for a file that does not exist", async () => {
    await expect(
      fsOps().write("a.txt", "v1", { expectedSha256: sha256Of("x") }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects oversized content", async () => {
    await expect(fsOps().write("big.txt", "x".repeat(101))).rejects.toThrow(
      TooLargeError,
    );
  });

  it("rejects content with null bytes", async () => {
    await expect(fsOps().write("bin.txt", "a\0b")).rejects.toThrow(
      InvalidContentError,
    );
  });

  it("leaves no temp files behind", async () => {
    await fsOps().write("a.txt", "hello");
    const names = await fs.readdir(ws.root);
    expect(names.filter((n: string) => n.startsWith(".tmp"))).toEqual([]);
  });
});

describe("read_file", () => {
  it("returns content and the full-file hash, even for partial reads", async () => {
    await fsOps().write("a.txt", "0123456789");
    const r = await fsOps().read("a.txt", 2, 3);
    expect(r.content).toBe("234");
    expect(r.truncated).toBe(true);
    expect(r.sha256).toBe(sha256Of("0123456789"));
  });

  it("refuses binary files", async () => {
    await fs.writeFile(
      path.join(ws.root, "img.bin"),
      new Uint8Array([0x89, 0x50, 0x00, 0x47]),
    );
    await expect(fsOps().read("img.bin")).rejects.toThrow(InvalidContentError);
  });

  it("refuses directories", async () => {
    await fs.mkdir(path.join(ws.root, "d"));
    await expect(fsOps().read("d")).rejects.toThrow(InvalidContentError);
  });
});

describe("edit_file", () => {
  it("replaces exactly one occurrence", async () => {
    await fsOps().write("a.txt", "foo bar baz");
    const r = await fsOps().edit("a.txt", "bar", "QUX");
    expect(await fs.readFile(path.join(ws.root, "a.txt"), "utf8")).toBe(
      "foo QUX baz",
    );
    expect(r.replacements).toBe(1);
  });

  it("rejects when old_string is missing", async () => {
    await fsOps().write("a.txt", "foo");
    await expect(fsOps().edit("a.txt", "nope", "x")).rejects.toThrow(
      ConflictError,
    );
  });

  it("rejects when old_string is ambiguous, including overlaps", async () => {
    await fsOps().write("a.txt", "foo foo");
    await expect(fsOps().edit("a.txt", "foo", "x")).rejects.toThrow(
      ConflictError,
    );
    await fsOps().write("b.txt", "aaa");
    await expect(fsOps().edit("b.txt", "aa", "x")).rejects.toThrow(
      ConflictError,
    );
  });

  it("honours expected_sha256 when given", async () => {
    await fsOps().write("a.txt", "foo");
    await expect(
      fsOps().edit("a.txt", "foo", "bar", sha256Of("stale")),
    ).rejects.toThrow(ConflictError);
  });
});

describe("move_file and delete_file", () => {
  it("moves a file and creates the destination directory", async () => {
    await fsOps().write("a.txt", "hi");
    const r = await fsOps().move("a.txt", "sub/b.txt");
    expect(r).toEqual({ from: "a.txt", to: "sub/b.txt" });
    expect(await fs.readFile(path.join(ws.root, "sub/b.txt"), "utf8")).toBe(
      "hi",
    );
  });

  it("refuses to clobber an existing destination", async () => {
    await fsOps().write("a.txt", "1");
    await fsOps().write("b.txt", "2");
    await expect(fsOps().move("a.txt", "b.txt")).rejects.toThrow(ConflictError);
  });

  it("refuses to move into .handoffs", async () => {
    await fsOps().write("a.txt", "1");
    await expect(fsOps().move("a.txt", ".handoffs/a.txt")).rejects.toThrow();
  });

  it("deletes only with the right hash", async () => {
    const w = await fsOps().write("a.txt", "bye");
    await expect(fsOps().remove("a.txt", sha256Of("wrong"))).rejects.toThrow(
      ConflictError,
    );
    await expect(fsOps().remove("a.txt", w.sha256)).resolves.toMatchObject({
      deleted: true,
    });
    await expect(fs.stat(path.join(ws.root, "a.txt"))).rejects.toThrow();
  });
});

describe("list_files and search_files", () => {
  it("lists the root and nested directories, hiding protected names", async () => {
    await fsOps().write("src/a.ts", "x");
    await fs.mkdir(path.join(ws.root, ".git"));
    await fs.mkdir(path.join(ws.root, "node_modules"));
    const flat = await fsOps().list(".");
    expect(flat.entries.map((e) => e.path)).toEqual(["src"]);
    const deep = await fsOps().list(".", true);
    expect(deep.entries.map((e) => e.path)).toEqual(["src", "src/a.ts"]);
  });

  it("does not follow symlinks while listing", async () => {
    await fs.symlink(ws.outside, path.join(ws.root, "link"), "junction");
    const r = await fsOps().list(".", true);
    expect(r.entries.map((e) => e.path)).not.toContain("link/secret.txt");
  });

  it("finds matches case-insensitively with line numbers", async () => {
    await fsOps().write("a.txt", "one\nTwo TODO here\nthree");
    const r = await fsOps().search("todo");
    expect(r.matches).toEqual([
      { path: "a.txt", line: 2, text: "Two TODO here" },
    ]);
  });

  it("skips binary files and truncates at the result limit", async () => {
    await fs.writeFile(
      path.join(ws.root, "bin.dat"),
      new Uint8Array([0, 1, 2, 116, 111, 100, 111]),
    );
    await fsOps().write("a.txt", "todo\ntodo\ntodo");
    const r = await fsOps().search("todo", ".", 2);
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.matches.every((m) => m.path === "a.txt")).toBe(true);
  });
});
