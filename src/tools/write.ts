import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BOM, loadTextFile, saveTextFile, type TextFile } from "./helpers/text-file.ts";
import { defineTool, type ToolContext, ToolError } from "./helpers/types.ts";
import { capLines, countLines, diffLines, displayPath, plural, resolvePath, splitLines } from "./helpers/utils.ts";

const schema = z.object({
  path: z.string().describe("Path to the file, relative to the working directory or absolute"),
  content: z.string().describe("The full content to write"),
});

interface WritePlan {
  abs: string;
  shown: string;
  existing: TextFile | null; // null: we're creating a new file
  text: string; // the new content, with "\n" line endings
  raw: string; // what goes to disk
}

export const writeTool = defineTool({
  name: "write",
  kind: "edit",
  subject: (args) => args.path, 
  description:
    "Create a new file, or replace ALL of an existing file's content. Creates parent directories. To overwrite an existing file you must have read it in this session (and it must not have changed since). To change part of a file, use edit.",
  schema,

  // "create" or "overwrite", plus a preview, so the person approving can tell the two apart.
  async describeAction(args, ctx) {
    const { shown, existing, text } = await planWrite(args, ctx);
    if (!existing) {
      return [`create ${shown} (${plural(countLines(text), "line")})`, ...capLines(splitLines(text).map((l) => `+${l}`), 20)].join("\n");
    }
    return [
      `overwrite ${shown} (replacing ${plural(countLines(existing.text), "line")} with ${countLines(text)})`,
      ...capLines(diffLines(existing.text, text), 40),
    ].join("\n");
  },

  async execute(args, ctx) {
    const { abs, shown, existing, text, raw } = await planWrite(args, ctx);
    if (existing?.raw === raw) return `No change: ${shown} already has exactly this content.`;
    if (!existing) await ctx.env.fs.mkdirp(path.dirname(abs));
    const mtimeMs = await saveTextFile(ctx.env.fs, abs, raw, { mode: existing?.mode, signal: ctx.signal });
    ctx.readFiles.set(abs, mtimeMs); // the model knows what's in it now: it wrote it

    const kept = [existing?.eol === "\r\n" && "CRLF line endings", existing?.bom && "byte-order mark"].filter(Boolean);
    return `${existing ? "Overwrote" : "Created"} ${shown} (${plural(countLines(text), "line")})${kept.length ? `, keeping its ${kept.join(" and ")}` : ""}.`;
  },
});

async function planWrite({ path: p, content }: z.infer<typeof schema>, ctx: ToolContext): Promise<WritePlan> {
  const abs = resolvePath(ctx.cwd, p);
  const shown = displayPath(ctx.cwd, abs);
  const existing = await loadTextFile( ctx.env.fs,abs, shown, ctx.signal); // refuses directories and binary files
  if (!existing) return { abs, shown, existing, text: content, raw: content }; // new file: exactly what the model wrote

  // Never replace a file the model hasn't seen (or has only seen an older version of):
  // whatever it didn't know was in there would be silently lost.
  const readAt = ctx.readFiles.get(abs);
  if (readAt === undefined) {
    throw new ToolError(`${shown} already exists and you haven't read it in this session. Read it first, or use edit to change part of it.`);
  }
  if (readAt !== existing.mtimeMs) {
    throw new ToolError(`${shown} has changed on disk since you last read it (the user or a command may have edited it). Read it again before overwriting it.`);
  }

  // Keep the file's format, not the model's habits: same line endings, same BOM.
  const text = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const body = existing.eol === "\r\n" ? text.replaceAll("\n", "\r\n") : text;
  return { abs, shown, existing, text, raw: existing.bom ? BOM + body : body };
}