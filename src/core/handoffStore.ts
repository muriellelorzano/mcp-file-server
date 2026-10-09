import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Limits } from "../config.js";
import { ConflictError, InvalidContentError, NotFoundError, TooLargeError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";

export const HANDOFF_DIR = ".handoffs";
export const HANDOFF_STATUSES = ["ready", "blocked", "done"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
export const HANDOFF_ID = /^[a-z0-9-]{1,32}-to-[a-z0-9-]{1,32}-\d{8}T\d{9}Z-[a-f0-9]{4}$/;

const AGENT = /^[a-z0-9-]{1,32}$/;
const MAX_SCAN = 500;
const STAMP = /(\d{8}T\d{9}Z)-[a-f0-9]{4}$/;

const MetaSchema = z
  .object({
    id: z.string().regex(HANDOFF_ID),
    from: z.string().regex(AGENT),
    to: z.string().regex(AGENT),
    status: z.enum(HANDOFF_STATUSES),
    task: z.string().min(1).max(200),
    created: z.string().max(40),
    files: z.array(z.string().max(512)).max(20),
    done: z.array(z.string().max(300)).max(20),
    next: z.array(z.string().max(300)).max(20),
    open_questions: z.array(z.string().max(300)).max(20),
  })
  .strict();

export type HandoffMeta = z.infer<typeof MetaSchema>;

export type HandoffInput = {
  to: string;
  task: string;
  status: HandoffStatus;
  done?: string[];
  next?: string[];
  openQuestions?: string[];
  files?: string[];
};

export type HandoffFilter = { to?: string; from?: string; status?: HandoffStatus; limit?: number };
export type HandoffSummary = Pick<HandoffMeta, "id" | "from" | "to" | "task" | "status" | "created">;

export type HandoffStore = ReturnType<typeof createHandoffStore>;

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function serialize(meta: HandoffMeta): string {
  const front = Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const section = (title: string, items: string[]) =>
    items.length ? `## ${title}\n${items.map((i) => `- ${oneLine(i)}`).join("\n")}\n\n` : "";
  return (
    `---\n${front}\n---\n\n# ${oneLine(meta.task)}\n\n` +
    section("Done", meta.done) +
    section("Next", meta.next) +
    section("Open questions", meta.open_questions) +
    section("Files", meta.files)
  );
}

function parse(text: string): { meta: HandoffMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new InvalidContentError("Malformed handoff: missing frontmatter");
  try {
    const entries: [string, unknown][] = m[1]!.split("\n").map((line) => {
      const i = line.indexOf(": ");
      if (i < 1) throw new Error("bad line");
      return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
    });
    return { meta: MetaSchema.parse(Object.fromEntries(entries)), body: m[2]!.trim() };
  } catch {
    throw new InvalidContentError("Malformed handoff: invalid frontmatter");
  }
}

export function createHandoffStore(deps: {
  sandbox: Sandbox;
  limits: Limits;
  knownAgents: ReadonlySet<string>;
}) {
  const { sandbox, limits, knownAgents } = deps;

  const makeId = (from: string, to: string) =>
    `${from}-to-${to}-${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;

  async function handoffDir() {
    // read access: sandbox only blocks WRITES into .handoffs, which is what we want for file tools
    return sandbox.resolveSafePath(HANDOFF_DIR);
  }

  async function readMeta(file: string) {
    const st = await fs.lstat(file); // lstat: a symlink is never a regular file
    if (!st.isFile()) throw new InvalidContentError("Not a regular file");
    if (st.size > limits.maxFileBytes) throw new TooLargeError("Handoff file too large");
    return parse(await fs.readFile(file, "utf8"));
  }

  const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

  /** `from` always comes from the authenticated agent, never from tool input. */
  async function write(from: string, input: HandoffInput) {
    if (!knownAgents.has(input.to)) throw new NotFoundError(`Unknown recipient: ${input.to}`);

    const files = new Set<string>();
    for (const f of input.files ?? []) {
      files.add(sandbox.toRelative(await sandbox.resolveSafePath(f))); // rejects escapes / protected paths
    }

    const dir = await handoffDir();
    await fs.mkdir(dir, { recursive: true });

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = makeId(from, input.to);
      const candidate: HandoffMeta = {
        id,
        from,
        to: input.to,
        status: input.status,
        task: input.task.trim(),
        created: new Date().toISOString(),
        files: [...files],
        done: input.done ?? [],
        next: input.next ?? [],
        open_questions: input.openQuestions ?? [],
      };
      const checked = MetaSchema.safeParse(candidate);
      if (!checked.success) throw new InvalidContentError("Invalid handoff fields");

      const data = Buffer.from(serialize(checked.data), "utf8");
      if (data.length > limits.maxFileBytes) {
        throw new TooLargeError(`Handoff is ${data.length} bytes; the limit is ${limits.maxFileBytes}`);
      }

      try {
        // "wx": never overwrite, so handoffs are append-only
        await fs.writeFile(path.join(dir, `${id}.md`), data, { flag: "wx", mode: 0o644 });
        return { id, path: `${HANDOFF_DIR}/${id}.md` };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new ConflictError("Could not allocate a unique handoff id; retry");
  }

  async function list(filter: HandoffFilter = {}) {
    const dir = await handoffDir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isMissing(err)) return { handoffs: [] as HandoffSummary[], skipped: 0 };
      throw err;
    }

    const candidates = names
      .filter((n) => n.endsWith(".md") && HANDOFF_ID.test(n.slice(0, -3)))
      .map((name) => ({ name, stamp: STAMP.exec(name.slice(0, -3))![1]! }))
      .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
      .slice(0, MAX_SCAN);

    const limit = Math.min(filter.limit ?? 20, 50);
    const handoffs: HandoffSummary[] = [];
    let skipped = 0;

    for (const c of candidates) {
      if (handoffs.length >= limit) break;
      try {
        const { meta } = await readMeta(path.join(dir, c.name));
        if (`${meta.id}.md` !== c.name) {
          skipped++;
          continue;
        }
        if (filter.to && meta.to !== filter.to) continue;
        if (filter.from && meta.from !== filter.from) continue;
        if (filter.status && meta.status !== filter.status) continue;
        handoffs.push({
          id: meta.id,
          from: meta.from,
          to: meta.to,
          task: meta.task,
          status: meta.status,
          created: meta.created,
        });
      } catch {
        skipped++; // malformed files are skipped, never fatal
      }
    }
    return { handoffs, skipped };
  }

  async function read(id: string) {
    if (!HANDOFF_ID.test(id)) throw new InvalidContentError("Invalid handoff id");
    const dir = await handoffDir();
    try {
      const r = await readMeta(path.join(dir, `${id}.md`));
      if (r.meta.id !== id) throw new InvalidContentError("Malformed handoff: id mismatch");
      return r;
    } catch (err) {
      if (isMissing(err)) throw new NotFoundError(`Not found: handoff ${id}`);
      throw err;
    }
  }

  return { write, list, read };
}