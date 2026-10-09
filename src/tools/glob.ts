import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { defineTool, ToolError } from "./helpers/types.ts";
import { displayPath, resolvePath } from "./helpers/utils.ts";
import { IGNORED, GLOB_HINT, findFiles  } from "./helpers/file-utils.ts";

const MAX_RESULTS = 200;

export const globTool = defineTool({
  name: "glob",
  description:
    'Find files by name pattern, e.g. "**/*.ts" or "src/**/*.test.ts". Returns matching paths (node_modules and .git are skipped).',
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
  }),

  async execute({ pattern, path: dir = "." }, ctx) {
    const base = resolvePath(ctx.cwd, dir);
    const { files: found, note } = await findFiles(pattern, base, ctx.cwd);
    const footer = note ? `\n\n[${note}]` : "";
    if (found.length === 0) return `No files match ${pattern} in ${displayPath(ctx.cwd, base)}. ${GLOB_HINT}${footer}`;
    // Report paths relative to the working directory, so they can be passed straight to read.
    const files = found.map((f) => displayPath(ctx.cwd, path.join(base, f)));
    const shown = files.slice(0, MAX_RESULTS).join("\n");
    const more = files.length > MAX_RESULTS ? `\n\n[${files.length - MAX_RESULTS} more files not shown. Use a more specific pattern.]` : "";
    return shown + more + footer;
  },
});