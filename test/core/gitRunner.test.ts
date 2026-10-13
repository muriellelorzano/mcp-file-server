import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, GitError, SandboxError } from "../../src/core/errors.js";
import { makeWorkspace, type TestWorkspace } from "../helpers.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let ws: TestWorkspace;
const git = () => ws.services.git;
const put = (rel: string, content: string) => fs.writeFile(path.join(ws.root, rel), content);

beforeEach(async () => {
  ws = await makeWorkspace();
  if (hasGit) await ws.services.git.ensureRepo();
});
afterEach(async () => {
  await ws.cleanup();
});

describe.skipIf(!hasGit)("gitRunner", () => {
  it("creates the repo once and is safe to call again", async () => {
    await expect(fs.stat(path.join(ws.root, ".git"))).resolves.toBeTruthy();
    expect((await git().ensureRepo()).created).toBe(false);
  });

  it("reports an unborn branch and untracked files in status", async () => {
    await put("a.txt", "one");
    const s = await git().status();
    expect(s.branch).toBe("main");
    expect(s.changed).toEqual([{ path: "a.txt", status: "untracked" }]);
  });

  it("returns an empty log before the first commit", async () => {
    expect(await git().log()).toEqual({ commits: [] });
  });

  it("commits under the agent identity", async () => {
    await put("a.txt", "one");
    const res = await git().commit("agent-a", "add a");
    expect(res.author).toBe("agent-a");
    expect(res.files).toEqual(["a.txt"]);

    const { commits } = await git().log();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ author: "agent-a", subject: "add a" });
  });

  it("records different authors for different agents", async () => {
    await put("a.txt", "one");
    await git().commit("agent-a", "from a");
    await put("b.txt", "two");
    await git().commit("agent-b", "from b");
    const { commits } = await git().log();
    expect(commits.map((c) => c.author)).toEqual(["agent-b", "agent-a"]);
  });

  it("refuses an empty commit", async () => {
    await expect(git().commit("agent-a", "nothing")).rejects.toThrow(ConflictError);
  });

  it("rejects a blank commit message", async () => {
    await put("a.txt", "one");
    await expect(git().commit("agent-a", "   ")).rejects.toThrow(GitError);
  });

  it("commits only the requested paths", async () => {
    await put("a.txt", "one");
    await put("b.txt", "two");
    const res = await git().commit("agent-a", "just a", ["a.txt"]);
    expect(res.files).toEqual(["a.txt"]);
    expect((await git().status()).changed).toEqual([{ path: "b.txt", status: "untracked" }]);
  });

  it("never commits .env even if it exists in the workspace", async () => {
    await put(".env", "SECRET=1");
    await put("a.txt", "one");
    const res = await git().commit("agent-a", "add a");
    expect(res.files).toEqual(["a.txt"]);
  });

  it("treats the message as data, not a shell command", async () => {
    await put("a.txt", "one");
    await git().commit("agent-a", `x"; touch pwned; echo "`);
    await expect(fs.stat(path.join(ws.root, "pwned"))).rejects.toThrow();
    expect((await git().log()).commits[0]!.subject).toBe(`x"; touch pwned; echo "`);
  });

  it("shows tracked-file changes in diff", async () => {
    await put("a.txt", "one");
    await git().commit("agent-a", "add a");
    await put("a.txt", "two");
    const { diff, truncated } = await git().diff("a.txt");
    expect(truncated).toBe(false);
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
  });

  it("truncates a diff that is over the limit", async () => {
    const small = await makeWorkspace({ MAX_DIFF_BYTES: "50" });
    try {
      await small.services.git.ensureRepo();
      await fs.writeFile(path.join(small.root, "a.txt"), "one\n");
      await small.services.git.commit("agent-a", "add a");
      await fs.writeFile(path.join(small.root, "a.txt"), "x".repeat(500));
      const res = await small.services.git.diff();
      expect(res.truncated).toBe(true);
      expect(res.diff.length).toBe(50);
    } finally {
      await small.cleanup();
    }
  });

  it("keeps protected paths out of reach", async () => {
    await expect(git().diff(".git/config")).rejects.toThrow(SandboxError);
    await expect(git().commit("agent-a", "x", [".env"])).rejects.toThrow(SandboxError);
    await expect(git().log(5, "../outside")).rejects.toThrow(SandboxError);
  });
});