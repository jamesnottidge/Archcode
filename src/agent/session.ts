import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "../model.ts";

// A session is an append-only JSONL file: one JSON object per line.
//   line 1:  {"type":"session", ...}        who/where/when
//   then:    {"type":"messages", ...}       one entry per finished (or interrupted) turn
// No database. Appending never rewrites old data, so a crash can't corrupt the past.

interface SessionHeader {
  type: "session";
  version: 1;
  session_id: string;
  cwd: string;
  model: string;
  created_at: string;
}

interface MessagesEntry {
  type: "messages";
  messages: Message[];
}

type Entry = SessionHeader | MessagesEntry;

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

    const entries = readEntries(path.join(sessionsDir(dataDir), file));
    const header = entries[0] as SessionHeader;
    const history = entries.flatMap((e) => (e.type === "messages" ? e.messages : []));
    return { log: new SessionLog(header.session_id, path.join(sessionsDir(dataDir), file)), history };
  }

  static list(dataDir: string): string[] {
    return listFiles(dataDir).map((file) => {
      const entries = readEntries(path.join(sessionsDir(dataDir), file));
      const header = entries[0] as SessionHeader;
      const firstUser = entries
        .flatMap((e) => (e.type === "messages" ? e.messages : []))
        .find((m) => m.role === "user");
      const preview = typeof firstUser?.content === "string" ? firstUser.content.replace(/\s+/g, " ").slice(0, 60) : "(empty)";
      return `${header.session_id.slice(0, 8)}  ${header.created_at.slice(0, 16).replace("T", " ")}  ${preview}`;
    });
  }

  append(messages: Message[]): void {
    if (messages.length > 0) this.write({ type: "messages", messages });
  }

  private write(entry: Entry): void {
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

function readEntries(file: string): Entry[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}