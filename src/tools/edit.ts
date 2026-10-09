import { z } from "zod";
import { findMatches, type Match } from "./helpers/edit-match.ts";
import { dominantEol, loadTextFile, saveTextFile, type TextFile, toRawRanges } from "./helpers/text-file.ts";
import { defineTool, type ToolContext, ToolError } from "./helpers/types.ts";
import { capLines, countLines, diffLines, displayPath, type LineIndex, lineIndex, plural, resolvePath } from "./helpers/utils.ts";

const schema = z.object({
  path: z.string().describe("Path to the file to edit"),
  old_string: z.string().describe("The text to replace, copied exactly from the file (including indentation)"),
  new_string: z.string().describe("The text to put in its place"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one (default false)"),
});


type EditArgs = z.infer<typeof schema>;

interface EditPlan {
  file: TextFile;
  shown: string; // the path as we show it
  lines: LineIndex; // line numbers for file.text
  matches: Match[]; // sorted, never overlapping
  notes: string[]; // what the model and the user should know ("re-indented...")
  after: string; // the whole file after the edit, normalized like file.text
  newRaw: string; // exactly what will be written to disk
}

export const editTool = defineTool({
  name: "edit",
  description:
    "Replace text in a file. Copy old_string exactly from the file, including indentation. It must appear exactly once (include a few surrounding lines to make it unique), or set replace_all to change every occurrence. If there's no exact match, edit retries ignoring indentation and quote style, and says so in its result. Read the file first.",
  schema,

  // The approval prompt shows the real diff, so the person can see exactly what will change.
  async describeAction(args, ctx) {
    const plan = await planEdit(args, ctx);
    return [
      `edit ${plan.shown} (${plural(plan.matches.length, "replacement")})`,
      ...plan.notes.map((note) => `note: ${note}`),
      ...capLines(diffPreview(plan), 40),
    ].join("\n");
  },

  async execute(args, ctx) {
    // Plan again: the file may have changed while the user was reading the prompt.
    const plan = await planEdit(args, ctx);
    const { file } = plan;
    const mtimeMs = await saveTextFile(file.path, plan.newRaw, { mode: file.mode, signal: ctx.signal });
    // If the model's read of this file was up to date, it still is: it made this change itself.
    // (Otherwise leave it stale, so `write` still insists on a fresh read.)
    if (ctx.readFiles.get(file.path) === file.mtimeMs) ctx.readFiles.set(file.path, mtimeMs);
    return report(plan);
  },
});

async function planEdit(args: EditArgs, ctx: ToolContext): Promise<EditPlan> {
  // Models write "\n". The file's own line endings are put back when we splice the raw text.
  const oldText = args.old_string.replaceAll("\r\n", "\n");
  const newText = args.new_string.replaceAll("\r\n", "\n");
  // These checks don't need the file, so they go first.
  if (oldText === "") throw new ToolError("old_string is empty. To create a file or replace all of it, use write.");
  if (oldText === newText) throw new ToolError("old_string and new_string are identical; there is nothing to change.");

  const abs = resolvePath(ctx.cwd, args.path);
  const shown = displayPath(ctx.cwd, abs);
  const file = await loadTextFile(abs, shown, ctx.signal); // refuses directories and binary files
  if (!file) throw new ToolError(`File not found: ${shown}. Use write to create new files.`);
  if (!file.validUtf8) {
    throw new ToolError(
      `${shown} is not valid UTF-8 (maybe Latin-1). Saving it would turn those bytes into "\uFFFD". Convert it first (e.g. with iconv via bash) or rewrite it with write.`,
    );
  }

  const lines = lineIndex(file.text);
  const { matches, notes } = findMatches(file.text, oldText, newText, args.replace_all ?? false, lines, shown);
  const after = splice(file.text, matches);
  const newRaw = spliceRaw(file, matches);
  if (newRaw === file.raw) {
    // Only possible after a loose match: the "new" text is what the file already says.
    throw new ToolError(
      `No change: ${shown} at line ${lines.lineAt(matches[0].start)} already reads exactly like new_string (${notes[0]}). Nothing was edited.`,
    );
  }
  return { file, shown, lines, matches, notes, after, newRaw };
}

// ───────────── applying, previewing, reporting ─────────────

// Put the replacements into text[from..to).
function splice(text: string, matches: Match[], from = 0, to = text.length): string {
  let out = "";
  let pos = from;
  for (const m of matches) {
    out += text.slice(pos, m.start) + m.replacement;
    pos = m.end;
  }
  return out + text.slice(pos, to);
}

// The same splice on the on-disk text. Every byte outside the replaced ranges stays exactly as it
// was (the BOM, each line's own ending), and each replacement gets the line endings of the text
// it replaces, so one edit in a mixed-endings file doesn't touch any other line.
function spliceRaw(file: TextFile, matches: Match[]): string {
  const ranges = toRawRanges(file, matches);
  let out = "";
  let pos = 0;
  matches.forEach((m, i) => {
    const { start, end } = ranges[i];
    const next = file.raw.indexOf("\n", end); // the ending of the line we're in, if the range has none
    const lineEol = next === -1 ? file.eol : file.raw[next - 1] === "\r" ? "\r\n" : "\n";
    const eol = dominantEol(file.raw.slice(start, end), lineEol);
    out += file.raw.slice(pos, start) + m.replacement.replaceAll("\n", eol);
    pos = end;
  });
  return out + file.raw.slice(pos);
}

// The diff for the approval prompt: one hunk per group of replacements that share lines.
function diffPreview({ file: { text }, matches, lines }: EditPlan): string[] {
  const out: string[] = [];
  for (let i = 0; i < matches.length; ) {
    const from = lines.starts[lines.lineAt(matches[i].start) - 1]; // start of the first line touched
    let j = i;
    let to = lineEnd(text, matches[j].end);
    while (j + 1 < matches.length && matches[j + 1].start <= to) to = lineEnd(text, matches[++j].end);
    const group = matches.slice(i, j + 1);
    out.push(...diffLines(text.slice(from, to), splice(text, group, from, to), lines.lineAt(from)));
    i = j + 1;
  }
  return out;
}

// What the model reads back: where the edit landed and how those lines read now,
// so it can check the result (especially after a loose match) without reading the file again.
function report({ shown, matches, notes, after }: EditPlan): string {
  const afterLines = lineIndex(after);
  let shift = 0; // how far later matches moved because earlier replacements changed length
  const spans = matches.map((m) => {
    const start = m.start + shift;
    shift += m.replacement.length - (m.end - m.start);
    return { start, end: start + m.replacement.length };
  });
  const at = spans.map((s) => afterLines.lineAt(s.start));
  let out = `Edited ${shown}: ${plural(matches.length, "replacement")} at line${at.length === 1 ? "" : "s"} ${at.slice(0, 20).join(", ")}${at.length > 20 ? ", ..." : ""}.`;
  for (const note of notes) out += `\nNote: ${note}.`;
  if (spans.length === 1) {
    const total = countLines(after);
    if (total === 0) return `${out}\n\n${shown} is now empty.`;
    const first = Math.max(1, Math.min(at[0], total) - 2);
    const last = Math.min(total, afterLines.lineAt(Math.max(spans[0].start, spans[0].end - 1)) + 2);
    let snippet = after.slice(afterLines.starts[first - 1], last < afterLines.starts.length ? afterLines.starts[last] - 1 : after.length).split("\n");
    if (snippet.length > 20) snippet = [...snippet.slice(0, 10), `[... ${snippet.length - 20} more lines ...]`, ...snippet.slice(-10)];
    out += `\n\nLines ${first}-${last} now read:\n${snippet.join("\n")}`;
  }
  return out;
}

function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf("\n", offset);
  return nl === -1 ? text.length : nl;
}