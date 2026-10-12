import { z } from "zod";
import { loadTextFile } from "./helpers/text-file.ts";
import { defineTool, ToolError } from "./helpers/types.ts";
import { displayPath, resolvePath, splitLines } from "./helpers/utils.ts";

const DEFAULT_LIMIT = 2000; // lines
const MAX_LINE_LENGTH = 2000; // characters; minified files have absurd lines
const MAX_CHARS = 25_000; // per call. Under the registry's 30k cap, so we stop at a whole line instead of being cut mid-file

export const readTool = defineTool({
  name: "read",
  kind: "read",
  subject: (args) => args.path,
  description:
    "Read a text file. Returns up to 2000 lines (and about 25,000 characters) per call; when there's more, the result says which offset to continue from.",
  schema: z.object({
    path: z.string().describe("Path to the file, relative to the working directory or absolute"),
    offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
  }),

  async execute({ path, offset = 1, limit = DEFAULT_LIMIT }, ctx) {
    const abs = resolvePath(ctx.cwd, path);
    const shown = displayPath(ctx.cwd, abs);
    const file = await loadTextFile(ctx.env.fs, abs, shown, ctx.signal);
    if (!file) throw new ToolError(`File not found: ${shown}`);
    // Remember that the model has seen this version of the file. `write` checks this record.
    ctx.readFiles.set(abs, file.mtimeMs);

    const lines = splitLines(file.text); // BOM and "\r\n" are already gone: the model sees plain "\n"
    if (lines.length === 0) return `(${shown} is empty)`; // an empty result would look like a failure
    const start = offset - 1;
    if (start >= lines.length) throw new ToolError(`offset ${offset} is past the end of ${shown} (${lines.length} lines).`);

    const out: string[] = [];
    let chars = 0;
    for (let i = start; i < lines.length && out.length < limit; i++) {
      const line = lines[i].length > MAX_LINE_LENGTH ? `${lines[i].slice(0, MAX_LINE_LENGTH)}… [line truncated]` : lines[i];
      if (out.length > 0 && chars + line.length > MAX_CHARS) break; // budget spent: stop at a line boundary
      out.push(line);
      chars += line.length + 1;
    }

    let result = out.join("\n");
    const end = start + out.length;
    if (start > 0 || end < lines.length) {
      // Tell the model there is more, and exactly how to get it.
      result += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length} in ${shown}.`;
      result += end < lines.length ? ` Use offset=${end + 1} to read more.]` : "]";
    }
    if (!file.validUtf8) {
      result += `\n\n[Note: ${shown} is not valid UTF-8; the bytes that aren't are shown as "\uFFFD". edit will refuse to change it.]`;
    }
    return result;
  },
});