import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, SandboxError } from "../core/errors.js";
import type { Services } from "../core/services.js";
import { ListFilesSchema, type ListFilesInput } from "./schemas.js";

type Entry = { type: "file" | "directory"; name: string; path: string };

export async function listFiles(
  input: ListFilesInput,
  services: Services,
): Promise<Entry[]> {
  const parsed = ListFilesSchema.parse(input);
  const { sandbox, config } = services;

  const abs = await sandbox.resolveSafePath(parsed.path, { mustExist: true });

  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new NotFoundError("Path is not a directory");
  }

  const entries: Entry[] = [];

  async function walk(dir: string, rel: string) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= config.limits.maxListEntries) {
        break;
      }

      const itemPath = rel ? path.posix.join(rel, item.name) : item.name;

      entries.push({
        type: item.isDirectory() ? "directory" : "file",
        name: item.name,
        path: itemPath,
      });

      if (parsed.recursive && item.isDirectory()) {
        await walk(path.join(dir, item.name), itemPath);
      }
    }
  }

  await walk(abs, parsed.path === "." ? "" : parsed.path);
  return entries;
}

