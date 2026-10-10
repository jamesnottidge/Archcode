import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Message } from "../model.ts";

// A session is an append-only JSONL file: one JSON object per line.
//   line 1:  {"type":"session", ...}        who/where/when
//   then:    {"type":"messages", ...}       one entry per finished (or interrupted) turn
// No database. Appending never rewrites old data, so a crash can't corrupt the past.

// ── Schemas: the file is data from OUTSIDE the program (a human may have edited it,
//    a crash may have cut it short), so we validate it instead of trusting a type cast.
//    The TypeScript types are derived from the schemas, so they can never disagree.

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

// Only the message shapes arch-code itself writes (string content, function tool calls).
const MessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(ToolCallSchema).optional() }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
]);

const HeaderSchema = z.object({
  type: z.literal("session"),
  version: z.literal(1),
  session_id: z.string(),
  cwd: z.string(),
  model: z.string(),
  created_at: z.string(),
});

const EntrySchema = z.discriminatedUnion("type", [
  HeaderSchema,
  z.object({ type: z.literal("messages"), messages: z.array(MessageSchema) }),
]);

type SessionHeader = z.infer<typeof HeaderSchema>;
type Entry = z.infer<typeof EntrySchema>;

export class SessionLog {
  readonly id: string;
  readonly file: string;

  private constructor(id: string, file: string) {
    this.id = id;
    this.file = file;
  }

  static create(dataDir: string, cwd: string, model: string): SessionLog {
    const dir = sessionsDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261007T193308Z
    const log = new SessionLog(id, path.join(dir, `${stamp}_${id}.jsonl`));
    log.write({ type: "session", version: 1, session_id: id, cwd, model, created_at: new Date().toISOString() });
    return log;
  }

  // Resume: find the file (by id prefix, or the latest one) and replay its messages.
  static open(dataDir: string, idPrefix?: string): { log: SessionLog; history: Message[] } {
    const files = listFiles(dataDir);
    const file = idPrefix ? files.find((f) => f.split("_")[1].startsWith(idPrefix)) : files.at(-1);
    if (!file) throw new Error(idPrefix ? `No session matching "${idPrefix}"` : "No sessions to resume yet");

    const fullPath = path.join(sessionsDir(dataDir), file);
    const { header, history } = load(fullPath);
    checkToolCallsAnswered(history, file);
    return { log: new SessionLog(header.session_id, fullPath), history };
  }

  static list(dataDir: string): string[] {
    return listFiles(dataDir).map((file) => {
      try {
        const { header, history } = load(path.join(sessionsDir(dataDir), file));
        const firstUser = history.find((m) => m.role === "user");
        const preview = typeof firstUser?.content === "string" ? firstUser.content.replace(/\s+/g, " ").slice(0, 60) : "(empty)";
        return `${header.session_id.slice(0, 8)}  ${header.created_at.slice(0, 16).replace("T", " ")}  ${preview}`;
      } catch (err) {
        return `(unreadable) ${file}: ${(err as Error).message.split("\n")[0]}`;
      }
    });
  }

  append(messages: Message[]): void {
    if (messages.length > 0) this.write({ type: "messages", messages });
  }

  private write(entry: SessionHeader | { type: "messages"; messages: Message[] }): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}

function sessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions");
}

function listFiles(dataDir: string): string[] {
  const dir = sessionsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); // timestamps sort chronologically
}

// Parse and validate every line. A bad line is reported with its line number,
// instead of surfacing later as a mysterious "undefined is not a function".
function readEntries(file: string): Entry[] {
  const name = path.basename(file);
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, lineNo }) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`${name} line ${lineNo} is not valid JSON (was the file cut off or edited?)`);
      }
      const parsed = EntrySchema.safeParse(json);
      if (!parsed.success) throw new Error(`${name} line ${lineNo} is malformed:\n${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
}

function load(file: string): { header: SessionHeader; history: Message[] } {
  const entries = readEntries(file);
  const header = entries[0];
  if (header?.type !== "session") throw new Error(`${path.basename(file)} does not start with a session header`);
  const history = entries.flatMap((e) => (e.type === "messages" ? e.messages : []));
  return { header, history };
}

// The schema checks each message's SHAPE. This checks a rule that spans messages:
// every tool call must have a matching result (Chapter 2), or the API rejects the
// whole history with a 400 the moment we resume.
function checkToolCallsAnswered(history: Message[], file: string): void {
  const answered = new Set(history.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const call of m.tool_calls ?? []) {
      if (!answered.has(call.id)) {
        throw new Error(`${file}: tool call ${call.id} has no result, so this session can't be resumed as-is.`);
      }
    }
  }
}