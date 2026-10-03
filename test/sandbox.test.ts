import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafe, assertWritable, SandboxError } from "../src/sandbox.ts";

let tmp: string, root: string, outside: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
  root = path.join(tmp, "ws");
  outside = path.join(tmp, "ws-evil"); // sibling sharing a name prefix
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  fs.mkdirSync(path.join(root, "sub"));
  fs.symlinkSync(outside, path.join(root, "link-to-outside"));           // dir symlink escape
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-file")); // file symlink escape
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveSafe: allowed", () => {
  test("simple file", () => assert.equal(resolveSafe(root, "a.txt"), path.join(fs.realpathSync(root), "a.txt")));
  test("nested not-yet-existing", () => assert.ok(resolveSafe(root, "sub/new/deep.txt").endsWith("deep.txt")));
  test("dot is the root", () => assert.equal(resolveSafe(root, "."), fs.realpathSync(root)));
  test(".. that stays inside", () => assert.ok(resolveSafe(root, "sub/../a.txt").endsWith("a.txt")));
});

describe("resolveSafe: rejected", () => {
  const bad: [string, string][] = [
    ["parent traversal", "../outside.txt"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal via subdir", "sub/../../x"],
    ["sibling with same prefix", "../ws-evil/secret.txt"],
    ["absolute posix", "/etc/passwd"],
    ["absolute windows", "C:\\Windows\\win.ini"],
    ["NUL byte", "a.txt\0.png"],
    ["symlinked dir", "link-to-outside/secret.txt"],
    ["new file under symlinked dir", "link-to-outside/new.txt"],
    ["symlinked file", "link-file"],
  ];
  for (const [name, p] of bad) {
    test(name, () => assert.throws(() => resolveSafe(root, p), SandboxError));
  }
  test("non-string", () => assert.throws(() => resolveSafe(root, 42 as unknown as string), SandboxError));
});

describe("assertWritable guards", () => {
  const abs = (p: string) => resolveSafe(root, p);
  test("blocks .git", () => assert.throws(() => assertWritable(root, abs(".git/config")), /protected/));
  test("blocks nested .git", () => assert.throws(() => assertWritable(root, abs("sub/.git/x")), /protected/));
  test("blocks append-only log", () => assert.throws(() => assertWritable(root, abs("PLAN_LOG.md")), /append-only/));
  test("blocks root", () => assert.throws(() => assertWritable(root, abs(".")), SandboxError));
  test("blocks oversize", () => assert.throws(() => assertWritable(root, abs("big.txt"), 2_000_000), /exceeds/));
  test("allows normal", () => assert.doesNotThrow(() => assertWritable(root, abs("notes.md"), 100)));
  test("allows PLAN_LOG.md in a subfolder (only root logs are protected)", () =>
    assert.doesNotThrow(() => assertWritable(root, abs("sub/PLAN_LOG.md"), 10)));
});
