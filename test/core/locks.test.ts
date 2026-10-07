import { describe, expect, it } from "vitest";
import { LockTimeoutError } from "../../src/core/errors.js";
import { createLocks } from "../../src/core/locks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("locks", () => {
  it("serializes work on the same key", async () => {
    const locks = createLocks(1000);
    const log: string[] = [];

    const task = (name: string, ms: number) =>
      locks.withLock("k", async () => {
        log.push(`${name}:start`);
        await sleep(ms);
        log.push(`${name}:end`);
      });

    await Promise.all([task("a", 30), task("b", 1)]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs different keys in parallel", async () => {
    const locks = createLocks(1000);
    const log: string[] = [];
    await Promise.all([
      locks.withLock("x", async () => { log.push("x:start"); await sleep(20); log.push("x:end"); }),
      locks.withLock("y", async () => { log.push("y:start"); await sleep(1); log.push("y:end"); }),
    ]);
    expect(log.slice(0, 2).sort()).toEqual(["x:start", "y:start"]);
  });

  it("times out waiting for a busy key, then recovers", async () => {
    const locks = createLocks(50);
    const holder = locks.withLock("k", () => sleep(200));
    await expect(locks.withLock("k", async () => "never")).rejects.toThrow(LockTimeoutError);
    await holder;
    await expect(locks.withLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("releases the lock when the task throws", async () => {
    const locks = createLocks(500);
    await expect(locks.withLock("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(locks.withLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("does not deadlock when two tasks lock the same pair in opposite order", async () => {
    const locks = createLocks(1000);
    const done = await Promise.all([
      locks.withLock(["a", "b"], async () => { await sleep(10); return 1; }),
      locks.withLock(["b", "a"], async () => { await sleep(10); return 2; }),
    ]);
    expect(done.sort()).toEqual([1, 2]);
  });

  it("lets only one of many concurrent hash-guarded writers win (integration)", async () => {
    const locks = createLocks(1000);
    let value = "v1";
    const attempt = (expected: string, next: string) =>
      locks.withLock("f", async () => {
        await sleep(2);
        if (value !== expected) throw new Error("conflict");
        value = next;
      });

    const results = await Promise.allSettled([attempt("v1", "A"), attempt("v1", "B"), attempt("v1", "C")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
