import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { findFiles, GLOB_HINT } from "./helpers/file-utils.ts";
import { loadTextFile } from "./helpers/text-file.ts";
import { defineTool, ToolError } from "./helpers/types.ts";
import { displayPath, plural, resolvePath, splitLines } from "./helpers/utils.ts";

const MAX_MATCHES = 100;
const MAX_FILE_SIZE = 1_000_000; // skip huge files (bundles, data dumps)

export const grepTool = defineTool({
  name: "grep",
  kind: "read",
  description:
    "Search file contents with a regular expression (JavaScript syntax). Returns matching lines as path:line: text. Use include to limit which files are searched.",
  schema: z.object({
    pattern: z.string().min(1).describe('Regular expression, e.g. "function\\s+load" or "TODO"'),
    path: z.string().optional().describe("File or directory to search (default: working directory)"),
    include: z.string().min(1).optional().describe('Glob for files to search, relative to path, e.g. "**/*.ts" (default: all files)'),
    ignore_case: z.boolean().optional().describe("Case-insensitive search"),
  }),

  async execute({ pattern, path: target = ".", include = "**/*", ignore_case = false }, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
    }

    // Which files? Either the single file we were given, or the ones under a directory.
    const base = resolvePath(ctx.cwd, target);
    const info = await ctx.env.fs.stat(base); // EACCESS and friends throw: the real reason, not not found. 
    if (!info) throw new ToolError(`Path not found: ${target}`);
    const isDir = info.kind === "dir";
    const listed = isDir ? await findFiles(ctx.env.fs, include, base, ctx.cwd, ctx.signal) : {files: [path.basename(base)], note: null}
    const dir = isDir ? base : path.dirname(base);
    const where = displayPath(ctx.cwd, base);
    if (listed.files.length === 0) {
      // Say so plainly. "No matches" here would make the model believe the text doesn't exist.
      return `No files in ${where} match include "${include}", so nothing was searched. ${GLOB_HINT}${listed.note ? `\n\n[${listed.note}]` : ""}`;
    }

    // Files we couldn't search: they might hold matches, so the model needs to know about them.
    const tooBig: string[] = [];
    const unreadable: string[] = [];
    let binary = 0;
    let searched = 0;
    const matches: string[] = [];
    let total = 0;

    for (const rel of listed.files) {
      ctx.signal.throwIfAborted(); // Esc: report "interrupted", not a partial "no matches"
      const file = path.join(dir, rel);
      const shown = displayPath(ctx.cwd, file);
      let text: string;
      try {
        if (((await ctx.env.fs.stat(file))?.size ?? 0) > MAX_FILE_SIZE) {
          tooBig.push(shown);
          continue;
        }
        // The same loader read and edit use: BOM removed and "\r\n" made "\n", so ^ and $ work on
        // Windows files too. Returns null if the file vanished since we listed it.
        const loaded = await loadTextFile(ctx.env.fs, file, shown, ctx.signal);
        if (!loaded) continue;
        text = loaded.text;
      } catch (err) {
        if (err instanceof ToolError) binary++; // binary (or not a regular file): nothing to search
        else if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(shown);
        continue;
      }
      searched++;
      splitLines(text).forEach((line, i) => {
        if (!regex.test(line)) return;
        total++;
        if (matches.length < MAX_MATCHES) matches.push(`${shown}:${i + 1}: ${line.trim().slice(0, 300)}`);
      });
    }

    const notes: string[] = [];
    if (tooBig.length > 0) notes.push(`${plural(tooBig.length, "file")} over 1 MB not searched (${list(tooBig)}); use bash to search them`);
    if (unreadable.length > 0) notes.push(`${plural(unreadable.length, "file")} couldn't be read (${list(unreadable)})`);
    if (listed.note) notes.push(listed.note);
    if (total === 0 && binary > 0) notes.push(`${plural(binary, "binary file")} skipped`);
    const footer = notes.length > 0 ? `\n\n[${notes.join(". ")}]` : "";

    if (total === 0) return `No matches for /${pattern}/ in ${plural(searched, "file")} searched.${footer}`;
    const extra = total > MAX_MATCHES ? `\n\n[${total - MAX_MATCHES} more matches not shown. Narrow the search.]` : "";
    return matches.join("\n") + extra + footer;
  },
});

function list(paths: string[]): string {
  return paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")}, ...`;
}