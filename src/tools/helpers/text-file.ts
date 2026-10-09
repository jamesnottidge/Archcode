// the key idea here is that every file has two views
// the raw that's exactly what's on disk, and the text, which is what the model sees. 
// a few differences between raw and text are: the BOM, the line ending style (\r\n vs \n) which varies across Operating systems. 
// the point of this file is to isolate all the places where functions should ideally ever deal with the raw format
// such that the tools and by extension the models, only ever see the text view. 

import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./types.ts";


export const BOM = "\uFEFF"; // byte-order mark: an invisible first character some editors add
const MAX_BYTES = 20 * 1024 * 1024; // bigger than this isn't source code

export interface TextFile {
  path: string; // absolute
  raw: string; // the content exactly as it is on disk
  text: string; // what the model sees and edits: no BOM, and every "\r\n" turned into "\n"
  bom: boolean;
  eol: "\n" | "\r\n"; // the line ending most of the file uses
  validUtf8: boolean; // false: some bytes aren't UTF-8 (Latin-1? corrupted?), decoded as "�"
  mtimeMs: number; // when the file was last modified, as of this load
  mode: number; // permissions, so rewriting a script keeps it executable
}

// Returns null if the file doesn't exist. Anything else that's wrong is either a
// ToolError the model can act on, or the real error (EACCES...), never disguised.
export async function loadTextFile(abs: string, shown: string, signal?: AbortSignal): Promise<TextFile | null> {
  let info;
  try {
    info = await stat(abs); // stat BEFORE reading: if the file changes in between, mtime looks stale, which is the safe side
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (info.isDirectory()) throw new ToolError(`${shown} is a directory, not a file. Use glob to see what's in it.`);
  if (!info.isFile()) throw new ToolError(`${shown} is not a regular file (it's a device, pipe or socket).`);
  if (info.size > MAX_BYTES) {
    throw new ToolError(`${shown} is ${(info.size / 1024 / 1024).toFixed(1)} MB, too big to handle as text. Use bash (head, tail, grep) to look at parts of it.`);
  }

  const bytes = await readFile(abs, { signal });
  // A NUL byte in the first 8 KB almost always means binary (images, zips, compiled code...).
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new ToolError(`${shown} looks like a binary file (it contains NUL bytes), not text.`);
  }

  // Decode strictly first, so we KNOW whether the file is valid UTF-8. A lenient decode would
  // silently turn bad bytes into "�", and saving that back would destroy them.
  // (ignoreBOM: true means "keep the BOM in the string", so we can see it and put it back.)
  let raw: string;
  let validUtf8 = true;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    validUtf8 = false;
  }

  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  return {
    path: abs,
    raw,
    text: body.replaceAll("\r\n", "\n"),
    bom,
    eol: dominantEol(body, "\n"),
    validUtf8,
    mtimeMs: info.mtimeMs,
    mode: info.mode,
  };
}

// Which line ending does this text mostly use? `fallback` when it has none (or a tie).
export function dominantEol(text: string, fallback: "\n" | "\r\n"): "\n" | "\r\n" {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : lf > crlf ? "\n" : fallback;
}

export interface Range {
  start: number;
  end: number; // exclusive
}

// `text` is `raw` minus the BOM and minus the "\r" of every "\r\n". Given ranges in `text`
// (sorted, not overlapping), find the same ranges in `raw`, so an edit can splice raw
// and leave every byte outside its ranges exactly as it was.
export function toRawRanges(file: TextFile, ranges: Range[]): Range[] {
  const { raw } = file;
  let t = 0; // a position in text...
  let r = file.bom ? 1 : 0; // ...and where that same character starts in raw
  const moveTo = (target: number) => {
    for (; t < target; t++) r += raw[r] === "\r" && raw[r + 1] === "\n" ? 2 : 1;
    return r;
  };
  // A "\n" that is "\r\n" on disk starts at its "\r", so a range that begins with it takes the
  // "\r" too, and a range that ends just before it leaves the "\r" alone.
  return ranges.map(({ start, end }) => ({ start: moveTo(start), end: moveTo(end) }));
}

// Save atomically: write a temporary file next to the target, then rename it over the target.
// A crash, a full disk or Esc halfway through leaves the original untouched; you never get half
// a file. (The trade-off, shared with vim and most editors: the file gets a new inode, so a hard
// link to it would keep pointing at the old content.) Returns the new modification time.
export async function saveTextFile(abs: string, raw: string, options: { mode?: number; signal?: AbortSignal } = {}): Promise<number> {
  const target = await realpath(abs).catch(() => abs); // follow a symlink: replace its target, not the link
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${Date.now()}.arch-code-tmp`);
  try {
    await writeFile(temp, raw, { encoding: "utf8", flag: "wx", signal: options.signal });
    if (options.mode !== undefined) await chmod(temp, options.mode & 0o7777); // keep permissions (executable scripts!)
    options.signal?.throwIfAborted(); // last moment to back out cleanly
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
  return (await stat(target)).mtimeMs;
}