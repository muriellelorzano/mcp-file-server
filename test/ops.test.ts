import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ops } from "../src/ops.ts";

let tmp: string, ops: Ops;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"));
  ops = new Ops(path.join(tmp, "ws"));
  await ops.init();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("file ops", () => {
  test("init seeds the four handoff files", () => {
    const files = ops.listFiles(".");
    for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]) assert.ok(files.includes(f), f);
  });
  test("write then read round-trips with matching version", () => {
    const w = ops.writeFile("src/hello.txt", "hi there");
    const r = ops.readFile("src/hello.txt");
    assert.equal(r.content, "hi there");
    assert.equal(r.version, w.version);
  });
  test("str_replace replaces exactly one match", () => {
    ops.writeFile("r.txt", "alpha beta");
    ops.strReplace("r.txt", "beta", "gamma");
    assert.equal(ops.readFile("r.txt").content, "alpha gamma");
  });
  test("str_replace rejects missing and ambiguous matches", () => {
    ops.writeFile("m.txt", "x x");
    assert.throws(() => ops.strReplace("m.txt", "zzz", "q"), /not found/);
    assert.throws(() => ops.strReplace("m.txt", "x", "q"), /2 places/);
  });
  test("str_replace treats $ literally", () => {
    ops.writeFile("d.txt", "price");
    ops.strReplace("d.txt", "price", "$& $1");
    assert.equal(ops.readFile("d.txt").content, "$& $1");
  });
  test("delete removes a file, refuses a directory", () => {
    ops.writeFile("gone.txt", "x");
    ops.deleteFile("gone.txt");
    assert.throws(() => ops.readFile("gone.txt"));
    assert.throws(() => ops.deleteFile("src"), /directory/);
  });
  test("search finds matches with line numbers", () => {
    ops.writeFile("s/a.ts", "one\nNeedle here\nthree");
    const hits = ops.searchFiles("needle");
    assert.deepEqual(hits.find(h => h.file === "s/a.ts"), { file: "s/a.ts", line: 2, text: "Needle here" });
  });
  test("traversal is rejected by every tool", () => {
    assert.throws(() => ops.readFile("../x"));
    assert.throws(() => ops.writeFile("../x", "a"));
    assert.throws(() => ops.strReplace("../x", "a", "b"));
    assert.throws(() => ops.deleteFile("../x"));
    assert.throws(() => ops.listFiles(".."));
    assert.throws(() => ops.searchFiles("a", ".."));
  });
});

describe("if_version locking", () => {
  test("stale version is refused, fresh version succeeds", () => {
    const a = ops.writeFile("lock.txt", "v1");
    ops.writeFile("lock.txt", "v2", a.version);                       // ok
    assert.throws(() => ops.writeFile("lock.txt", "v3", a.version), /Version conflict/); // stale
    assert.throws(() => ops.strReplace("lock.txt", "v2", "v4", a.version), /Version conflict/);
  });
  test("'absent' means create-only", () => {
    ops.writeFile("fresh.txt", "x", "absent");
    assert.throws(() => ops.writeFile("fresh.txt", "y", "absent"), /Version conflict/);
  });
});

describe("handoff protocol", () => {
  test("append-only logs reject write/replace/delete but accept handoff_append", () => {
    assert.throws(() => ops.writeFile("PLAN_LOG.md", "wiped"), /append-only/);
    assert.throws(() => ops.strReplace("PLAN_LOG.md", "PLAN_LOG", "x"), /append-only/);
    assert.throws(() => ops.deleteFile("DECISIONS.md"), /append-only/);
    ops.handoffAppend("DECISIONS", "Use stateless HTTP", "tester");
    assert.match(ops.handoffRead()["DECISIONS.md"], /Use stateless HTTP/);
  });
  test("PROJECT_STATE is writable but not deletable", () => {
    ops.writeFile("PROJECT_STATE.md", "# PROJECT_STATE\n- Status: running");
    assert.throws(() => ops.deleteFile("PROJECT_STATE.md"), /cannot be deleted/);
  });
  test("cannot touch .git through file tools", () => {
    assert.throws(() => ops.writeFile(".git/config", "x"), /protected/);
    assert.throws(() => ops.deleteFile(".git/HEAD"), /protected/);
  });
});

describe("git-lite", () => {
  test("status -> commit -> log", async () => {
    ops.writeFile("g.txt", "git me");
    assert.match(await ops.gitStatus(), /g\.txt/);
    assert.match(await ops.gitDiff(), /.+/);
    const c = await ops.gitCommit("add g.txt");
    assert.match(c, /add g\.txt/);
    assert.match(await ops.gitLog(3), /add g\.txt/);
    assert.equal(await ops.gitCommit("again"), "nothing to commit");
  });
  test("commit message can't inject flags/shell", async () => {
    ops.writeFile("h.txt", "x");
    await ops.gitCommit("--amend; touch pwned");
    assert.ok(!fs.existsSync(path.join(ops.root, "pwned")));
  });
});
