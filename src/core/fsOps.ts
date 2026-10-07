import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError, InvalidContentError, NotFoundError, TooLargeError } from "./errors.js";
import type { Limits } from "../config.js";
import type { Locks } from "./locks.js";
import type { Sandbox } from "./sandbox.js";

const TEMP_SUFFIX = ".tmp";

/** Result types */
export type Entry = { path: string; type: "file" | "dir"; size: number; mtime: string };
export type ListResult = { entries: Entry[]; truncated: boolean };
export type ReadResult = { path: string; content: string; sha256: string; size: number; offset: number; truncated: boolean };
export type SearchMatch = { path: string; line: number; text: string };
export type SearchResult = { matches: SearchMatch[]; truncated: boolean };
export type WriteResult = { path: string; sha256: string; size: number; created: boolean };
export type EditResult = { path: string; sha256: string; replacements: number };
export type MoveResult = { from: string; to: string };
export type RemoveResult = { deleted: boolean };

export type FsOps = ReturnType<typeof createFsOps>;

export function createFsOps(sandbox: Sandbox, locks: Locks, limits: Limits) {
  // ---------- helpers ----------

  function sha256Of(data: Buffer | string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  function assertSize(size: number, max: number): void {
    if (size > max) throw new TooLargeError(`File too large: ${size} bytes (max ${max})`);
  }

  function assertText(buf: Buffer): string {
    if (buf.includes(0)) throw new InvalidContentError("Binary files are not supported");
    return buf.toString("utf8");
  }

  async function statOrNull(abs: string) {
    return fs.stat(abs).catch(() => null);
  }

  async function readBuf(abs: string, relForErr: string): Promise<Buffer> {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new InvalidContentError(`Not a regular file: ${relForErr}`);
    assertSize(st.size, limits.maxReadBytes);
    return fs.readFile(abs);
  }

  function checkHash(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new ConflictError(`File changed since you read it (current sha256: ${actual})`);
    }
  }

  async function mkdirParents(abs: string) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }

  async function atomicWrite(abs: string, data: Buffer) {
    const tmp = abs + TEMP_SUFFIX;
    await fs.writeFile(tmp, data, { mode: 0o644 });
    await fs.rename(tmp, abs);
  }

  async function* walk(start: string, recursive: boolean) {
    const queue = [start];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (sandbox.isDenied(d.name) || d.isSymbolicLink()) continue;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          yield { abs, type: "dir" as const };
          if (recursive) queue.push(abs);
        } else if (d.isFile()) {
          yield { abs, type: "file" as const };
        }
      }
    }
  }

  // ---------- read-only ----------

  async function list(rel = ".", recursive = false): Promise<ListResult> {
    const start = await sandbox.resolveSafePath(rel, { mustExist: true, allowRoot: true });
    const st = await fs.stat(start);
    if (!st.isDirectory()) throw new InvalidContentError(`Not a directory: ${rel}`);

    const entries: Entry[] = [];
    let truncated = false;

    for await (const item of walk(start, recursive)) {
      if (entries.length >= limits.maxListEntries) {
        truncated = true;
        break;
      }
      const s = await fs.stat(item.abs).catch(() => null);
      if (!s) continue;
      entries.push({
        path: sandbox.toRelative(item.abs),
        type: item.type,
        size: item.type === "file" ? s.size : 0,
        mtime: s.mtime.toISOString(),
      });
    }
    return { entries, truncated };
  }

  async function read(rel: string, offset = 0, length?: number): Promise<ReadResult> {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true });
    const buf = await readBuf(abs, rel);
    const text = assertText(buf);
    const end = length === undefined ? text.length : offset + length;
    const content = text.slice(offset, end);
    return {
      path: sandbox.toRelative(abs),
      content,
      sha256: sha256Of(buf),
      size: buf.length,
      offset,
      truncated: offset + content.length < text.length,
    };
  }

  async function search(query: string, rel = ".", maxResults = 50): Promise<SearchResult> {
    const start = await sandbox.resolveSafePath(rel, { mustExist: true, allowRoot: true });
    const st = await fs.stat(start);
    const limit = Math.min(maxResults, 100);
    const needle = query.toLowerCase();

    async function* files() {
      if (st.isFile()) {
        yield start;
        return;
      }
      for await (const item of walk(start, true)) {
        if (item.type === "file") yield item.abs;
      }
    }

    const matches: SearchMatch[] = [];
    let truncated = false;
    let scanned = 0;

    outer: for await (const file of files()) {
      if (++scanned > limits.maxSearchFiles) {
        truncated = true;
        break;
      }
      const s = await fs.stat(file).catch(() => null);
      if (!s || s.size > limits.maxReadBytes) continue;

      let text: string;
      try {
        text = assertText(await fs.readFile(file));
      } catch {
        continue;
      }

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break outer;
        }
        matches.push({
          path: sandbox.toRelative(file),
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
      }
    }
    return { matches, truncated };
  }

  // ---------- writes ----------

  async function write(
    rel: string,
    content: string,
    opts: { expectedSha256?: string; createOnly?: boolean } = {},
  ): Promise<WriteResult> {
    const data = Buffer.from(content, "utf8");
    assertSize(data.length, limits.maxFileBytes);
    assertText(data);

    const abs = await sandbox.resolveSafePath(rel, { write: true });

    return locks.withLock(abs, async () => {
      const st = await statOrNull(abs);
      let created = true;

      if (st) {
        created = false;
        if (!st.isFile()) throw new InvalidContentError(`Not a regular file: ${rel}`);
        if (opts.createOnly) throw new ConflictError(`File already exists: ${rel}`);
        if (!opts.expectedSha256) {
          throw new ConflictError(
            "expected_sha256 is required to overwrite an existing file (call read_file first)",
          );
        }
        checkHash(opts.expectedSha256, sha256Of(await readBuf(abs, rel)));
      } else if (opts.expectedSha256) {
        throw new ConflictError(`File does not exist but expected_sha256 was given: ${rel}`);
      }

      await mkdirParents(abs);
      await atomicWrite(abs, data);
      return { path: sandbox.toRelative(abs), sha256: sha256Of(data), size: data.length, created };
    });
  }

  async function edit(rel: string, oldStr: string, newStr: string, expectedSha256?: string): Promise<EditResult> {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true, write: true });

    return locks.withLock(abs, async () => {
      const buf = await readBuf(abs, rel);
      const text = assertText(buf);
      if (expectedSha256) checkHash(expectedSha256, sha256Of(buf));

      const first = text.indexOf(oldStr);
      if (first === -1) throw new ConflictError("old_string not found in file");
      if (text.indexOf(oldStr, first + 1) !== -1) {
        throw new ConflictError("old_string matches more than once; add more context");
      }

      const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
      const data = Buffer.from(next, "utf8");
      assertSize(data.length, limits.maxFileBytes);
      assertText(data);

      await atomicWrite(abs, data);
      return { path: sandbox.toRelative(abs), sha256: sha256Of(data), replacements: 1 };
    });
  }

  async function move(fromRel: string, toRel: string): Promise<MoveResult> {
    const src = await sandbox.resolveSafePath(fromRel, { mustExist: true, write: true });
    const dst = await sandbox.resolveSafePath(toRel, { write: true });
    if (src === dst) throw new ConflictError("Source and destination are the same");

    return locks.withLock([src, dst], async () => {
      const st = await statOrNull(src);
      if (!st) throw new NotFoundError(`Not found: ${fromRel}`);
      if (!st.isFile()) throw new InvalidContentError("Only files can be moved");
      if (await statOrNull(dst)) throw new ConflictError(`Destination already exists: ${toRel}`);

      await mkdirParents(dst);
      await fs.rename(src, dst);
      return { from: sandbox.toRelative(src), to: sandbox.toRelative(dst) };
    });
  }

  async function remove(rel: string, expectedSha256: string): Promise<RemoveResult> {
    const abs = await sandbox.resolveSafePath(rel, { mustExist: true, write: true });

    return locks.withLock(abs, async () => {
      const buf = await readBuf(abs, rel);
      checkHash(expectedSha256, sha256Of(buf));
      await fs.unlink(abs);
      return { deleted: true };
    });
  }

  return Object.freeze({ list, read, search, write, edit, move, remove });
}
