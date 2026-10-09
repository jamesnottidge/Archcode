import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, ToolError } from "./types.ts";
import { countLines, displayPath, resolvePath } from "./utils.ts";

export const editTool = defineTool({
  name: "edit",
  description:
    "Replace one exact snippet in a file. old_string must match the file exactly (including indentation) and must appear exactly once; include a few surrounding lines to make it unique. Read the file first.",
  schema: z.object({
    path: z.string().describe("Path to the file to edit"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The text to put in its place"),
  }),

  describeAction: ({ path, old_string, new_string }) =>
    `edit ${path} (-${countLines(old_string)} +${countLines(new_string)} lines)`,

  async execute({ path, old_string, new_string }, ctx) {
    const file = resolvePath(ctx.cwd, path);
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) throw new ToolError(`File not found: ${path}. Use write to create new files.`);

    // 1. Normalize: models always write "\n", but Windows-made files use "\r\n",
    //    and some files start with an invisible byte-order mark (BOM).
    const hasBom = raw.startsWith("﻿");
    let text = hasBom ? raw.slice(1) : raw;
    const usesCrlf = text.includes("\r\n");
    text = text.replaceAll("\r\n", "\n");
    const oldText = old_string.replaceAll("\r\n", "\n");
    const newText = new_string.replaceAll("\r\n", "\n");

    if (oldText === "") throw new ToolError("old_string is empty. Use write to create or replace whole files.");
    if (oldText === newText) throw new ToolError("old_string and new_string are identical; nothing to change.");

    // 2. Try an exact match. It must be unique, or we might edit the wrong spot.
    let updated: string;
    const exactMatches = text.split(oldText).length - 1;
    if (exactMatches === 1) {
      // A function as the replacement stops JS from interpreting "$&" or "$1"
      // inside new_string as special patterns. (Classic bug!)
      updated = text.replace(oldText, () => newText);
    } else if (exactMatches > 1) {
      throw new ToolError(
        `old_string is ambiguous: ${exactMatches} matches in ${path}. Include more surrounding lines so it matches exactly once.`,
      );
    } else {
      // 3. No exact match. Models often get indentation or trailing spaces
      //    slightly wrong, so retry comparing whole lines with whitespace trimmed.
      updated = fuzzyReplace(text, oldText, newText, path);
    }

    // 4. Restore the file's original line endings and BOM, then save.
    if (usesCrlf) updated = updated.replaceAll("\n", "\r\n");
    if (hasBom) updated = `﻿${updated}`;
    await writeFile(file, updated, "utf8");
    return `Edited ${displayPath(ctx.cwd, file)} (replaced 1 occurrence).`;
  },
});

function fuzzyReplace(text: string, oldText: string, newText: string, path: string): string {
  const fileLines = text.split("\n");
  const wanted = oldText.split("\n").map((l) => l.trim());
  const starts: number[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    if (wanted.every((w, j) => fileLines[i + j].trim() === w)) starts.push(i);
  }
  if (starts.length === 0) {
    throw new ToolError(
      `old_string not found in ${path}. Read the file again and copy the exact text, including whitespace.`,
    );
  }
  if (starts.length > 1) {
    throw new ToolError(`old_string is ambiguous: ${starts.length} matches in ${path}. Include more surrounding lines.`);
  }
  const i = starts[0];
  return [...fileLines.slice(0, i), ...newText.split("\n"), ...fileLines.slice(i + wanted.length)].join("\n");
}