import { LockTimeoutError } from "./errors.js";

export type Locks = ReturnType<typeof createLocks>;

export function createLocks(timeoutMs: number) {
  const tails = new Map<string, Promise<void>>();

  async function acquire(key: string): Promise<() => void> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LockTimeoutError("File busy, retry")), timeoutMs);
    });

    try {
      await Promise.race([prev, timeout]);
    } catch (err) {
      release(); // don't block the queue behind a waiter that gave up
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return release;
  }

  /** Runs fn while holding every key. Keys are taken in sorted order to avoid deadlock. */
  async function withLock<T>(keys: string | string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(Array.isArray(keys) ? keys : [keys])].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of sorted) releases.push(await acquire(key));
      return await fn();
    } finally {
      for (const r of releases.reverse()) r();
    }
  }

  return { withLock };
}

